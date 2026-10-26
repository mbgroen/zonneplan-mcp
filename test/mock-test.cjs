// End-to-end test tegen een nep-Zonneplan-API: login-flow, token refresh en alle tools.
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const STATE = path.join(process.env.TMPDIR || '/tmp', `zp-mock-${process.pid}`);
fs.rmSync(STATE, { recursive: true, force: true });

const CONN = 'conn-1111';
const P1 = 'p1-2222';
const PV = 'pv-3333';
const BAT = 'bat-4444';
let tokenGen = 0;
let validToken = null;
const calls = [];

const now = new Date();
const iso = (h) => { const d = new Date(now); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
const prices = [];
for (let i = -12; i < 36; i++) {
  const s = new Date(Date.now() + i * 3600e3); s.setUTCMinutes(0, 0, 0);
  const e = new Date(s.getTime() + 3600e3);
  prices.push({ start_date: s.toISOString(), end_date: e.toISOString(), price_tax_included: { amount: 2000000 + ((i * 37) % 11) * 100000 }, price_tax_excluded: { amount: 1600000 }, sustainability_score: { permille: 455 }, tariff_group: i % 3 ? 'normal' : 'low' });
}

const routes = {
  'POST /oauth/authorize-challenge': (body) => body.otp
    ? (body.otp === '123456' ? [200, { authorization_code: 'abc' }] : [422, { message: 'Invalid OTP' }])
    : [403, { auth_session: 'sess-1', otp_required: true, expires_in: 600 }],
  'POST /oauth/token': (body) => {
    if (body.grant_type === 'authorization_code' && body.code === 'abc' && body.code_verifier) { }
    else if (body.grant_type === 'refresh_token' && body.refresh_token === `refresh-${tokenGen}`) { }
    else return [400, { error: 'invalid_grant' }];
    tokenGen++; validToken = `access-${tokenGen}`;
    return [200, { access_token: validToken, refresh_token: `refresh-${tokenGen}`, expires_in: 3600, token_type: 'Bearer' }];
  },
  'GET /user-accounts/me': () => [200, { data: {
    user_account: { full_name: 'Test Gebruiker', email: 'test@example.com' },
    address_groups: [{ uuid: 'ag', address: { street: 'Teststraat', number: '1', addition: 'a', zipcode: '8000 AA', city: 'Zwolle', sunrise: iso(6), sunset: iso(17) },
      connections: [{ uuid: CONN, ean: '871234', market_segment: 'electricity', contracts: [
        { uuid: P1, type: 'p1_installation', label: 'Zonneplan Connect', meta: { electricity_last_measured_delivery_value: 420, electricity_last_measured_production_value: 0, electricity_last_measured_average_value: 410, electricity_last_measured_at: iso(10), dsmr_version: '5.0' } },
        { uuid: PV, type: 'pv_installation', label: 'Zonnepanelen', meta: { last_measured_power_value: 1830, total_power_measured: 12345678, panel_count: 12, panel_wp: 400, installation_wp: 4800, last_measured_at: iso(10), total_earned: 1234500000 } },
        { uuid: BAT, type: 'home_battery_installation', label: 'Nexus', meta: { state_of_charge: 735, power_ac: -1200, battery_state: 'charging', cycle_count: 88 } },
      ] }] }] } }],
  [`GET /connections/${CONN}/summary`]: () => [200, { data: { usage: { value: 410, measured_at: iso(10), status_message: 'Je verbruikt weinig', status_tip: 'Goed bezig' } } }],
  [`GET /connections/${CONN}/electricity-delivered`]: () => [200, { data: { measurement_groups: [
    { type: 'hours', date: iso(0), totals: { d: 5432, p: 2100 }, meta: { delivery_costs_incl_tax: 15000000, production_costs_incl_tax: 4000000, delivery_price_per_unit_incl_tax: 2600000 }, measurements: [{ date: iso(8), values: { d: 300, p: 0 } }] },
    { type: 'days', date: iso(0), totals: { d: 5432, p: 2100 } },
    { type: 'months', date: iso(0), totals: { d: 154320, p: 98000 }, meta: { delivery_costs_incl_tax: 420000000, production_costs_incl_tax: 210000000 } },
    { type: 'years', date: iso(0), totals: { d: 2154320, p: 1898000 } },
  ] } }],
  [`GET /connections/${CONN}/electricity-delivered/charts/hours?date=2026-10-01`]: () => [200, { data: { measurement_groups: [{ type: 'hours', date: '2026-10-01T00:00:00+02:00', totals: { d: 9000, p: 3000 }, measurements: [{ date: '2026-10-01T10:00:00+02:00', values: { d: 500, p: 120 } }] }] } }],
  [`GET /connections/${CONN}/electricity-home-consumption`]: () => [200, { data: { measurement_groups: [{ type: 'days', total: 8000 }] } }],
  [`GET /connections/${CONN}/gas`]: () => [200, { data: { measurement_groups: [{ type: 'days', total: 2345, meta: { delivery_costs_incl_tax: 31000000 } }, { type: 'months', total: 45000 }, { type: 'years', total: 900000 }] } }],
  [`GET /connections/${CONN}/pv-installation`]: () => [200, { data: { contracts: [{ uuid: PV, label: 'Zonnepanelen', meta: { last_measured_power_value: 1830, total_power_measured: 12345678 } }], measurement_groups: [{ type: 'days', date: iso(0), total: 9100 }] } }],
  [`GET /connections/${CONN}/home-battery-installation/${BAT}`]: () => [200, { data: { contracts: [{ uuid: BAT, meta: { state_of_charge: 735, total_earned: 987650000, total_day: 12300000, delivery_day: 4200, production_day: 3900 } }] } }],
  [`GET /api/contracts/${BAT}/home-battery/control-mode`]: () => [200, { data: { control_mode: 'dynamic_charging', modes: { dynamic_charging: { available: true, enabled: true }, self_consumption: { available: true, enabled: false } } } }],
  'GET /api/consumer-prices/charts/electricity-hourly': () => [200, { data: { chart: { series: { prices } } } }],
};

const api = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const key = `${req.method} ${req.url}`;
    calls.push(key);
    let parsed = {};
    try { parsed = body ? JSON.parse(body) : {}; } catch {}
    let handler = routes[key];
    if (!handler && req.url.startsWith(`/contracts/${BAT}/home_battery_installation/charts/`)) {
      handler = () => [200, { data: [{ label: 'Powerplay', measurements: [{ date: '2026-09-01T00:00:00+02:00', value: 150000000 }, { date: '2026-10-01T00:00:00+02:00', value: 98000000 }] }] }];
    }
    if (!req.url.startsWith('/oauth') && req.headers.authorization !== `Bearer ${validToken}`) {
      res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"message":"Unauthenticated."}');
    }
    if (!handler) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"message":"Not found"}'); }
    const [status, json] = handler(parsed);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(json));
  });
});

setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 30000).unref();
api.listen(0, async () => {
  const base = `http://127.0.0.1:${api.address().port}`;
  const p = spawn('node', [path.join(__dirname, '..', 'bundle', 'server', 'index.cjs')], {
    env: { ...process.env, ZONNEPLAN_API_BASE: base, ZONNEPLAN_STATE_DIR: STATE, ZONNEPLAN_EMAIL: 'test@example.com' },
  });
  let buf = '';
  const pending = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = JSON.parse(line);
      if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  p.stderr.on('data', (d) => process.stderr.write(`  [server] ${d}`));
  let id = 0;
  const rpc = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  const call = async (name, args = {}) => {
    const m = await rpc('tools/call', { name, arguments: args });
    const text = m.result?.content?.[0]?.text ?? JSON.stringify(m.error);
    const flag = m.result?.isError ? 'FOUT' : 'OK';
    console.log(`\n=== ${name} ${JSON.stringify(args)} → ${flag}\n${text.length > 1600 ? text.slice(0, 1600) + '\n…' : text}`);
    return { ok: !m.result?.isError, text };
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mock', version: '1' } });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const results = [];
  results.push(!(await call('zonneplan_status')).text.includes('"ingelogd": true'));
  results.push((await call('zonneplan_login_start')).ok);
  results.push(!(await call('zonneplan_login_complete', { code: '654321' })).ok);
  results.push((await call('zonneplan_login_complete', { code: '123456' })).ok);
  const mode = fs.statSync(path.join(STATE, 'tokens.json')).mode & 0o777;
  console.log(`\ntokens.json mode: ${mode.toString(8)}`);
  results.push(mode === 0o600);
  results.push((await call('zonneplan_status')).ok);
  // Simuleer verlopen access token: server moet automatisch verversen
  validToken = 'rotated-elsewhere';
  tokenGen = tokenGen; // refresh-token blijft geldig
  results.push((await call('zonneplan_live')).ok);
  results.push((await call('zonneplan_electricity')).ok);
  results.push((await call('zonneplan_electricity', { date: '2026-10-01' })).ok);
  results.push((await call('zonneplan_gas')).ok);
  results.push((await call('zonneplan_solar')).ok);
  results.push((await call('zonneplan_battery', { include_charts: true })).ok);
  results.push((await call('zonneplan_prices', { day: 'today' })).ok);
  results.push(!(await call('zonneplan_charge_point')).ok); // geen laadpaal → nette fout
  results.push((await call('zonneplan_api_get', { path: `/connections/${CONN}/summary` })).ok);
  results.push(!(await call('zonneplan_api_get', { path: 'https://evil.example/x' })).ok);
  results.push((await call('zonneplan_logout')).ok);
  results.push(!(await call('zonneplan_electricity')).ok);

  const refreshed = calls.filter((c) => c === 'POST /oauth/token').length;
  console.log(`\nToken-aanroepen: ${refreshed} (verwacht 2: login + 1 refresh)`);
  results.push(refreshed === 2);
  const passed = results.filter(Boolean).length;
  console.log(`\nResultaat: ${passed}/${results.length} checks geslaagd`);
  p.kill(); api.close();
  fs.rmSync(STATE, { recursive: true, force: true });
  process.exit(passed === results.length ? 0 : 1);
});
