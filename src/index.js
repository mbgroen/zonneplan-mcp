#!/usr/bin/env node
/**
 * Zonneplan MCP server (onofficieel)
 *
 * Read-only MCP server voor de Zonneplan app-API (app-api.zonneplan.nl).
 * Gebaseerd op de API-kennis uit:
 *   - https://github.com/biemond/nl.zonneplan (Homey app, GPL-3.0)
 *   - https://github.com/fsaris/home-assistant-zonneplan-one (Home Assistant integratie)
 *
 * Inloggen gaat via e-mail + 6-cijferige code (OAuth authorize-challenge met PKCE).
 * Tokens worden lokaal bewaard in ~/.zonneplan-mcp/tokens.json (alleen leesbaar voor jou).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import dns from 'node:dns';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pkg from '../package.json';

// De Homey-app forceert IPv4 voor deze API; doe hetzelfde om IPv6-problemen te vermijden.
dns.setDefaultResultOrder('ipv4first');

const SERVER_VERSION = pkg.version;
const API_BASE = process.env.ZONNEPLAN_API_BASE || 'https://app-api.zonneplan.nl'; // override alleen voor tests
const APP_VERSION = process.env.ZONNEPLAN_APP_VERSION || '5.10.1';
const TZ = 'Europe/Amsterdam';
const ACCOUNT_CACHE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

const CONTRACT = {
  P1: 'p1_installation',
  PV: 'pv_installation',
  BATTERY: 'home_battery_installation',
  CHARGE_POINT: 'charge_point_installation',
};

function cleanEnv(v) {
  if (!v) return '';
  const s = String(v).trim();
  // Niet-ingevulde user_config placeholders negeren
  if (s.startsWith('${')) return '';
  return s;
}

const CONFIG_EMAIL = cleanEnv(process.env.ZONNEPLAN_EMAIL);
const STATE_DIR = cleanEnv(process.env.ZONNEPLAN_STATE_DIR) || path.join(os.homedir(), '.zonneplan-mcp');
const TOKEN_FILE = path.join(STATE_DIR, 'tokens.json');
const PENDING_FILE = path.join(STATE_DIR, 'pending-login.json');

const log = (...args) => console.error('[zonneplan-mcp]', ...args);

// ---------------------------------------------------------------------------
// Opslag
// ---------------------------------------------------------------------------

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(file, data) {
  await fs.mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  try {
    await fs.chmod(file, 0o600);
  } catch {
    /* Windows */
  }
}

async function removeFile(file) {
  try {
    await fs.unlink(file);
  } catch {
    /* bestaat niet */
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class ZonneplanError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function baseHeaders() {
  return {
    'Content-Type': 'application/json;charset=utf-8',
    Accept: 'application/json',
    'x-app-version': APP_VERSION,
    'x-app-environment': 'production',
    'User-Agent': `zonneplan-mcp/${SERVER_VERSION}`,
  };
}

async function rawRequest(method, apiPath, { body, token, okStatuses = [200, 201, 204] } = {}) {
  const headers = baseHeaders();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(API_BASE + apiPath, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ZonneplanError(`Kan Zonneplan niet bereiken (${err?.cause?.code || err.message}).`, { code: 'network' });
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!okStatuses.includes(res.status)) {
    if (res.status === 429) {
      const retry = res.headers.get('retry-after');
      throw new ZonneplanError(
        `Zonneplan rate limit bereikt. Probeer het ${retry ? `over ${retry} seconden` : 'later'} opnieuw.`,
        { status: 429, code: 'rate_limit' },
      );
    }
    const apiMsg = json?.message || json?.error_description || json?.error || (text && text.length < 300 ? text : '');
    throw new ZonneplanError(`Zonneplan API gaf status ${res.status}${apiMsg ? `: ${apiMsg}` : ''} (${method} ${apiPath})`, {
      status: res.status,
    });
  }

  return { status: res.status, json, text };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

let refreshInFlight = null;

function tokenRecord(resp, email) {
  const now = Date.now();
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    token_type: resp.token_type || 'Bearer',
    expires_at: resp.expires_in ? now + Number(resp.expires_in) * 1000 : null,
    obtained_at: new Date(now).toISOString(),
    email: email || null,
  };
}

async function loadTokens() {
  const t = await readJson(TOKEN_FILE);
  if (!t?.access_token || !t?.refresh_token) return null;
  return t;
}

async function refreshTokens() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const current = await loadTokens();
    if (!current) throw new ZonneplanError('Niet ingelogd.', { code: 'not_logged_in' });
    let resp;
    try {
      resp = await rawRequest('POST', '/oauth/token', {
        body: { grant_type: 'refresh_token', refresh_token: current.refresh_token },
      });
    } catch (err) {
      if (err.status === 400 || err.status === 401) {
        throw new ZonneplanError(
          'De Zonneplan-sessie is verlopen of ingetrokken. Log opnieuw in met zonneplan_login_start.',
          { code: 'session_expired', status: err.status },
        );
      }
      throw err;
    }
    if (!resp.json?.access_token || !resp.json?.refresh_token) {
      throw new ZonneplanError('Onverwacht antwoord bij vernieuwen van het token.');
    }
    const rec = tokenRecord(resp.json, current.email);
    await writeJson(TOKEN_FILE, rec);
    log('Token vernieuwd');
    return rec;
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function apiGet(apiPath) {
  let tokens = await loadTokens();
  if (!tokens) {
    throw new ZonneplanError(
      'Nog niet ingelogd bij Zonneplan. Gebruik eerst zonneplan_login_start (stuurt een code naar je e-mail) en daarna zonneplan_login_complete.',
      { code: 'not_logged_in' },
    );
  }
  if (tokens.expires_at && Date.now() > tokens.expires_at - 60_000) {
    tokens = await refreshTokens();
  }
  try {
    return (await rawRequest('GET', apiPath, { token: tokens.access_token })).json;
  } catch (err) {
    if (err.status === 401) {
      tokens = await refreshTokens();
      return (await rawRequest('GET', apiPath, { token: tokens.access_token })).json;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Account / contracten
// ---------------------------------------------------------------------------

let accountCache = null;

async function getAccount({ fresh = false } = {}) {
  if (!fresh && accountCache && Date.now() - accountCache.at < ACCOUNT_CACHE_MS) return accountCache.data;
  const resp = await apiGet('/user-accounts/me');
  const data = resp?.data ?? resp;
  if (!data?.address_groups) throw new ZonneplanError('Onverwacht antwoord van /user-accounts/me.');
  accountCache = { at: Date.now(), data };
  return data;
}

function allContracts(account) {
  const out = [];
  for (const group of account.address_groups || []) {
    for (const connection of group.connections || []) {
      for (const contract of connection.contracts || []) {
        out.push({ group, connection, contract });
      }
    }
  }
  return out;
}

function formatAddress(a) {
  if (!a) return null;
  const nr = [a.number, a.addition].filter(Boolean).join('');
  return [a.street && `${a.street} ${nr}`.trim(), [a.zipcode, a.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null;
}

/** Zoek contracten van een type, optioneel beperkt tot één aansluiting. */
async function findContracts(type, connectionUuid) {
  const account = await getAccount();
  const list = allContracts(account).filter(
    (c) => c.contract.type === type && (!connectionUuid || c.connection.uuid === connectionUuid),
  );
  if (!list.length) {
    const label = {
      [CONTRACT.P1]: 'P1-meter (Zonneplan Connect)',
      [CONTRACT.PV]: 'zonnepanelen',
      [CONTRACT.BATTERY]: 'thuisbatterij',
      [CONTRACT.CHARGE_POINT]: 'laadpaal',
    }[type] || type;
    throw new ZonneplanError(
      `Geen ${label} gevonden op dit account${connectionUuid ? ` voor aansluiting ${connectionUuid}` : ''}. Gebruik zonneplan_status om te zien wat er wel is.`,
      { code: 'not_found' },
    );
  }
  return list;
}

/** Aansluitingen waarop elektriciteitsdata te verwachten is (P1 of stroomcontract). */
async function electricityConnections(connectionUuid) {
  const account = await getAccount();
  const conns = [];
  for (const group of account.address_groups || []) {
    for (const connection of group.connections || []) {
      if (connectionUuid && connection.uuid !== connectionUuid) continue;
      conns.push({ group, connection });
    }
  }
  if (!conns.length) throw new ZonneplanError(`Aansluiting ${connectionUuid} niet gevonden.`, { code: 'not_found' });
  if (connectionUuid) return conns;
  // Voorkeur: aansluitingen met een P1-contract; anders alle aansluitingen.
  const withP1 = conns.filter((c) => (c.connection.contracts || []).some((k) => k.type === CONTRACT.P1));
  return withP1.length ? withP1 : conns;
}

// ---------------------------------------------------------------------------
// Conversies
// ---------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d = 3) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : v);
const whToKwh = (v) => (isNum(v) ? round(v / 1000, 3) : v ?? null);
const toEur = (v, d = 2) => (isNum(v) ? round(v / 1e7, d) : v ?? null);
const toEurPrecise = (v) => toEur(v, 5);

function localTime(iso) {
  if (!iso) return iso;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('nl-NL', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function localDate(d = new Date()) {
  return localTime(d.toISOString()).slice(0, 10);
}

// Bekende velden in contract-meta → leesbare naam + eenheid
const META_RULES = {
  // P1
  electricity_last_measured_delivery_value: ['actueel_afname_van_net_w', (v) => v],
  electricity_last_measured_production_value: ['actueel_teruglevering_aan_net_w', (v) => v],
  electricity_last_measured_average_value: ['actueel_gemiddeld_w', (v) => v],
  electricity_last_measured_at: ['stroom_laatst_gemeten', localTime],
  electricity_last_measured_production_at: ['teruglevering_laatst_gemeten', localTime],
  electricity_first_measured_at: ['stroom_eerste_meting', localTime],
  gas_last_measured_at: ['gas_laatst_gemeten', localTime],
  gas_first_measured_at: ['gas_eerste_meting', localTime],
  // Zonnepanelen
  last_measured_power_value: ['actueel_vermogen_w', (v) => v],
  total_power_measured: ['totaal_opgewekt_kwh', whToKwh],
  installation_wp: ['installatie_wp', (v) => v],
  panel_wp: ['paneel_wp', (v) => v],
  panel_count: ['aantal_panelen', (v) => v],
  last_measured_at: ['laatst_gemeten', localTime],
  first_measured_at: ['eerste_meting', localTime],
  // Batterij / Powerplay
  state_of_charge: ['laadniveau_pct', (v) => (isNum(v) ? round(v / 10, 1) : v)],
  power_ac: ['vermogen_ac_w', (v) => v],
  total_earned: ['totaal_verdiend_eur', toEur],
  total_day: ['verdiend_vandaag_eur', toEur],
  average_day: ['gemiddeld_verdiend_per_dag_eur', toEur],
  delivery_day: ['geladen_van_net_vandaag_kwh', whToKwh],
  production_day: ['ontladen_naar_net_vandaag_kwh', whToKwh],
};

function convertContractMeta(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    const rule = META_RULES[k];
    if (rule && v !== null && v !== undefined) out[rule[0]] = rule[1](v);
    else out[k] = v;
  }
  return out;
}

/** Converteer meta van een measurement group (kosten/prijzen staan in 1e-7 euro). */
function convertGroupMeta(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (isNum(v) && /price/.test(k)) out[`${k}_eur`] = toEurPrecise(v);
    else if (isNum(v) && /(cost|earn|amount|compensation)/.test(k)) out[`${k}_eur`] = toEur(v);
    else out[k] = v;
  }
  const d = meta.delivery_costs_incl_tax;
  const p = meta.production_costs_incl_tax;
  if (isNum(d) && isNum(p)) out.netto_kosten_incl_btw_eur = toEur(d - p);
  return out;
}

function convertTotals(totals) {
  if (!totals || typeof totals !== 'object') return totals;
  const out = {};
  for (const [k, v] of Object.entries(totals)) {
    if (k === 'd') out.afname_van_net_kwh = whToKwh(v);
    else if (k === 'p') out.teruglevering_aan_net_kwh = whToKwh(v);
    else out[`${k}_kwh`] = whToKwh(v);
  }
  if (isNum(totals.d) && isNum(totals.p)) out.netto_afname_kwh = whToKwh(totals.d - totals.p);
  return out;
}

function convertMeasurement(m, kind) {
  if (!m || typeof m !== 'object') return m;
  const out = {};
  for (const [k, v] of Object.entries(m)) {
    if ((k === 'values' || k === 'totals') && v && typeof v === 'object') Object.assign(out, convertTotals(v));
    else if ((k === 'value' || k === 'total') && isNum(v)) out[kind === 'gas' ? 'm3' : 'kwh'] = whToKwh(v);
    else if (k === 'meta') out.meta = convertGroupMeta(v);
    else if ((k === 'date' || k === 'measured_at' || k.endsWith('_at')) && typeof v === 'string') out[k] = localTime(v);
    else out[k] = v;
  }
  return out;
}

/**
 * Measurement groups (bv. vandaag / deze maand / dit jaar) leesbaar maken.
 * kind: 'electricity' (Wh, totals.d/p) | 'gas' (dm³ → m³) | 'pv' (Wh)
 */
function convertGroups(groups, kind, { includeMeasurements = false } = {}) {
  if (!Array.isArray(groups)) return groups;
  return groups.map((g) => {
    const out = {};
    for (const [k, v] of Object.entries(g)) {
      if (k === 'measurements') continue;
      if (k === 'totals') out.totalen = convertTotals(v);
      else if (k === 'total' && isNum(v)) out[kind === 'gas' ? 'totaal_m3' : 'totaal_kwh'] = whToKwh(v);
      else if (k === 'meta') out.kosten = convertGroupMeta(v);
      else if ((k === 'date' || k.endsWith('_at')) && typeof v === 'string') out[k] = localTime(v);
      else out[k] = v;
    }
    if (Array.isArray(g.measurements)) {
      out.aantal_metingen = g.measurements.length;
      if (includeMeasurements) out.metingen = g.measurements.map((m) => convertMeasurement(m, kind));
    }
    return out;
  });
}

function unwrap(resp) {
  return resp && typeof resp === 'object' && 'data' in resp ? resp.data : resp;
}

// ---------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------

function ok(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
}

function fail(err) {
  const msg = err instanceof ZonneplanError ? err.message : `Onverwachte fout: ${err?.message || err}`;
  log('Fout:', msg);
  return { isError: true, content: [{ type: 'text', text: msg }] };
}

function tool(fn) {
  return async (args) => {
    try {
      return ok(await fn(args || {}));
    } catch (err) {
      return fail(err);
    }
  };
}

async function tryGet(apiPath) {
  try {
    return { ok: true, data: unwrap(await apiGet(apiPath)) };
  } catch (err) {
    if (err.code === 'not_logged_in' || err.code === 'session_expired' || err.code === 'rate_limit') throw err;
    return { ok: false, error: err.message };
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const connectionArg = z
  .string()
  .optional()
  .describe('Optioneel: uuid van de aansluiting (zie zonneplan_status). Standaard wordt de juiste aansluiting automatisch gekozen.');

const dateArg = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Gebruik formaat JJJJ-MM-DD')
  .optional();

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: 'zonneplan', version: SERVER_VERSION },
  {
    instructions: [
      'Read-only toegang tot het Zonneplan-account van de gebruiker: stroomverbruik (afname van het net), teruglevering, gas, zonnepanelen, thuisbatterij (Powerplay), laadpaal en dynamische energieprijzen.',
      'Begin met zonneplan_status. Als de gebruiker niet is ingelogd: roep zonneplan_login_start aan, vraag de gebruiker om de 6-cijferige code uit de e-mail van Zonneplan, en roep daarna zonneplan_login_complete aan met die code. Daarna blijft de sessie bewaard en wordt het token automatisch vernieuwd.',
      'Eenheden in de antwoorden staan in de veldnamen (_kwh, _w, _eur, _m3). Tijden zijn lokale tijd (Europe/Amsterdam).',
      '"afname_van_net" = stroom die van het net komt (verbruik); "teruglevering_aan_net" = stroom die naar het net gaat. "kosten.production_costs_*" is de vergoeding voor teruglevering.',
    ].join('\n'),
  },
);

// --- Login ------------------------------------------------------------------

server.registerTool(
  'zonneplan_login_start',
  {
    title: 'Zonneplan: inloggen (stap 1)',
    description:
      'Start het inloggen bij Zonneplan. Zonneplan stuurt een 6-cijferige code naar het e-mailadres. Vraag de gebruiker daarna om die code en roep zonneplan_login_complete aan. Gebruikt standaard het e-mailadres uit de extensie-instellingen.',
    inputSchema: {
      email: z.string().email().optional().describe('E-mailadres van het Zonneplan-account (optioneel als het in de instellingen staat).'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  tool(async ({ email }) => {
    const mail = (email || CONFIG_EMAIL || '').trim();
    if (!mail) {
      throw new ZonneplanError('Geen e-mailadres bekend. Geef het e-mailadres van je Zonneplan-account op.');
    }
    const codeVerifier = crypto.randomBytes(64).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const resp = await rawRequest('POST', '/oauth/authorize-challenge', {
      body: {
        response_type: 'code',
        email: mail,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        source_name: `Claude (Zonneplan MCP) - ${os.hostname()}`.slice(0, 255),
      },
      // 403 + otp_required is het verwachte "succes"-antwoord van deze endpoint
      okStatuses: [200, 201, 403],
    });
    const j = resp.json || {};
    if (!j.auth_session || j.otp_required !== true) {
      throw new ZonneplanError(`Onverwacht antwoord van Zonneplan bij het aanvragen van de code: ${resp.text?.slice(0, 300)}`);
    }
    const expiresIn = Number(j.expires_in) || 600;
    await writeJson(PENDING_FILE, {
      auth_session: j.auth_session,
      code_verifier: codeVerifier,
      email: mail,
      expires_at: Date.now() + expiresIn * 1000,
    });
    return {
      status: 'code_verstuurd',
      email: mail,
      geldig_minuten: Math.round(expiresIn / 60),
      volgende_stap: 'Vraag de gebruiker om de 6-cijferige code uit de e-mail van Zonneplan en roep zonneplan_login_complete aan.',
    };
  }),
);

server.registerTool(
  'zonneplan_login_complete',
  {
    title: 'Zonneplan: inloggen (stap 2)',
    description: 'Rond het inloggen af met de 6-cijferige code die Zonneplan per e-mail heeft gestuurd (na zonneplan_login_start).',
    inputSchema: {
      code: z.string().regex(/^\s*\d{6}\s*$/, 'De code bestaat uit 6 cijfers').describe('De 6-cijferige code uit de e-mail.'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  tool(async ({ code }) => {
    const pending = await readJson(PENDING_FILE);
    if (!pending?.auth_session) {
      throw new ZonneplanError('Er loopt geen inlogpoging. Start eerst met zonneplan_login_start.');
    }
    if (pending.expires_at && Date.now() > pending.expires_at) {
      await removeFile(PENDING_FILE);
      throw new ZonneplanError('De code is verlopen. Start opnieuw met zonneplan_login_start.');
    }
    let auth;
    try {
      auth = await rawRequest('POST', '/oauth/authorize-challenge', {
        body: { auth_session: pending.auth_session, otp: code.trim() },
      });
    } catch (err) {
      if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
        throw new ZonneplanError(`De code werd niet geaccepteerd (status ${err.status}). Controleer de code of vraag een nieuwe aan met zonneplan_login_start.`);
      }
      throw err;
    }
    const authCode = auth.json?.authorization_code;
    if (!authCode) throw new ZonneplanError('Onverwacht antwoord: geen authorization_code ontvangen.');

    const tok = await rawRequest('POST', '/oauth/token', {
      body: { grant_type: 'authorization_code', code: authCode, code_verifier: pending.code_verifier },
    });
    if (!tok.json?.access_token || !tok.json?.refresh_token) {
      throw new ZonneplanError('Onverwacht antwoord: geen tokens ontvangen.');
    }
    await writeJson(TOKEN_FILE, tokenRecord(tok.json, pending.email));
    await removeFile(PENDING_FILE);
    accountCache = null;

    const account = await getAccount({ fresh: true });
    return {
      status: 'ingelogd',
      naam: account.user_account?.full_name || account.user_account?.first_name || null,
      email: account.user_account?.email || pending.email,
      installaties: [...new Set(allContracts(account).map((c) => c.contract.type))],
      tokens_opgeslagen_in: TOKEN_FILE,
    };
  }),
);

server.registerTool(
  'zonneplan_logout',
  {
    title: 'Zonneplan: uitloggen',
    description: 'Verwijdert de lokaal opgeslagen Zonneplan-tokens van deze computer.',
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  tool(async () => {
    await removeFile(TOKEN_FILE);
    await removeFile(PENDING_FILE);
    accountCache = null;
    return { status: 'uitgelogd', verwijderd: TOKEN_FILE };
  }),
);

// --- Overzicht ----------------------------------------------------------------

server.registerTool(
  'zonneplan_status',
  {
    title: 'Zonneplan: account en installaties',
    description:
      'Laat zien of je bent ingelogd en geeft een overzicht van het account: adres(sen), aansluitingen (EAN, uuid) en contracten/installaties (P1-meter, zonnepanelen, thuisbatterij, laadpaal, stroom/gas). Begin hiermee.',
    inputSchema: {},
    annotations: READ_ONLY,
  },
  tool(async () => {
    const tokens = await loadTokens();
    if (!tokens) {
      const pending = await readJson(PENDING_FILE);
      return {
        ingelogd: false,
        inlogcode_aangevraagd: Boolean(pending && (!pending.expires_at || Date.now() < pending.expires_at)),
        email_in_instellingen: CONFIG_EMAIL || null,
        volgende_stap: 'Roep zonneplan_login_start aan; Zonneplan mailt dan een 6-cijferige code.',
      };
    }
    const account = await getAccount({ fresh: true });
    return {
      ingelogd: true,
      gebruiker: {
        naam: account.user_account?.full_name || null,
        email: account.user_account?.email || tokens.email,
      },
      adressen: (account.address_groups || []).map((g) => ({
        adres: formatAddress(g.address),
        zonsopkomst: g.address?.sunrise ? localTime(g.address.sunrise) : undefined,
        zonsondergang: g.address?.sunset ? localTime(g.address.sunset) : undefined,
        aansluitingen: (g.connections || []).map((c) => ({
          uuid: c.uuid,
          ean: c.ean || null,
          segment: c.market_segment || null,
          contracten: (c.contracts || []).map((k) => ({
            uuid: k.uuid,
            type: k.type,
            label: k.label,
            start: k.start_date || null,
            eind: k.end_date || null,
          })),
        })),
      })),
    };
  }),
);

server.registerTool(
  'zonneplan_live',
  {
    title: 'Zonneplan: actuele waarden',
    description:
      'Actuele momentopname: huidig vermogen van de P1-meter (afname/teruglevering in W), huidig vermogen en totaal van de zonnepanelen, laadniveau en vermogen van de thuisbatterij, laadpaalstatus en het actuele verbruik volgens Zonneplan.',
    inputSchema: {},
    annotations: READ_ONLY,
  },
  tool(async () => {
    const account = await getAccount({ fresh: true });
    const result = { opgehaald_op: localTime(new Date().toISOString()), aansluitingen: [] };
    for (const group of account.address_groups || []) {
      for (const connection of group.connections || []) {
        const entry = { adres: formatAddress(group.address), aansluiting_uuid: connection.uuid, ean: connection.ean || null };
        for (const k of connection.contracts || []) {
          const meta = convertContractMeta(k.meta);
          if (k.type === CONTRACT.P1) (entry.p1_meter ||= []).push({ label: k.label, ...meta });
          else if (k.type === CONTRACT.PV) (entry.zonnepanelen ||= []).push({ label: k.label, ...meta });
          else if (k.type === CONTRACT.BATTERY) (entry.thuisbatterij ||= []).push({ label: k.label, ...meta });
          else if (k.type === CONTRACT.CHARGE_POINT) (entry.laadpaal ||= []).push({ label: k.label, ...meta });
        }
        if ((connection.contracts || []).some((k) => k.type === CONTRACT.P1)) {
          const summary = await tryGet(`/connections/${connection.uuid}/summary`);
          if (summary.ok && summary.data?.usage) {
            const u = summary.data.usage;
            entry.zonneplan_samenvatting = {
              actueel_verbruik_w: u.value ?? null,
              gemeten_op: localTime(u.measured_at),
              status: u.status_message ?? null,
              tip: u.status_tip ?? null,
            };
          }
        }
        result.aansluitingen.push(entry);
      }
    }
    return result;
  }),
);

// --- Elektriciteit -------------------------------------------------------------

server.registerTool(
  'zonneplan_electricity',
  {
    title: 'Zonneplan: stroomverbruik en teruglevering',
    description:
      'Stroom via de P1-meter: afname van het net (verbruik), teruglevering aan het net, netto, en kosten/vergoeding incl. en excl. btw. Zonder datum: overzicht met perioden zoals vandaag, deze maand en dit jaar. Met datum: grafiekdata voor die dag (per uur) of, met period, per dag/maand/jaar.',
    inputSchema: {
      date: dateArg.describe('Optioneel: datum JJJJ-MM-DD voor historische grafiekdata (bijv. een specifieke dag).'),
      period: z
        .enum(['hours', 'days', 'months', 'years'])
        .optional()
        .describe('Alleen met date: resolutie van de grafiek. "hours" = per uur van die dag (standaard), "days" = per dag van die maand, "months" = per maand van dat jaar, "years" = per jaar.'),
      include_measurements: z.boolean().optional().describe('Ook de losse metingen teruggeven (standaard: alleen bij een datum).'),
      include_home_consumption: z.boolean().optional().describe('Ook het totale thuisverbruik ophalen (incl. eigen zonnestroom), alleen in het overzicht. Standaard true.'),
      connection_uuid: connectionArg,
      raw: z.boolean().optional().describe('Onbewerkt API-antwoord teruggeven (voor debuggen).'),
    },
    annotations: READ_ONLY,
  },
  tool(async ({ date, period, include_measurements, include_home_consumption = true, connection_uuid, raw }) => {
    const conns = await electricityConnections(connection_uuid);
    const out = [];
    for (const { group, connection } of conns) {
      const base = `/connections/${connection.uuid}`;
      const entry = { adres: formatAddress(group.address), aansluiting_uuid: connection.uuid };
      if (date) {
        const p = period || 'hours';
        const resp = await apiGet(`${base}/electricity-delivered/charts/${p}?date=${date}`);
        if (raw) return resp;
        const data = unwrap(resp);
        entry.datum = date;
        entry.resolutie = p;
        entry.perioden = convertGroups(data?.measurement_groups, 'electricity', {
          includeMeasurements: include_measurements ?? true,
        });
      } else {
        const resp = await apiGet(`${base}/electricity-delivered`);
        if (raw) return resp;
        const data = unwrap(resp);
        entry.perioden = convertGroups(data?.measurement_groups, 'electricity', {
          includeMeasurements: include_measurements ?? false,
        });
        if (include_home_consumption) {
          const hc = await tryGet(`${base}/electricity-home-consumption`);
          if (hc.ok && hc.data) {
            entry.thuisverbruik = hc.data.measurement_groups
              ? convertGroups(hc.data.measurement_groups, 'electricity', { includeMeasurements: false })
              : hc.data;
          }
        }
      }
      out.push(entry);
    }
    return out.length === 1 ? out[0] : out;
  }),
);

// --- Gas -----------------------------------------------------------------------

server.registerTool(
  'zonneplan_gas',
  {
    title: 'Zonneplan: gasverbruik',
    description:
      'Gasverbruik via de P1-meter in m³ met kosten incl. en excl. btw. Zonder datum: overzicht (bijv. vandaag, deze maand, dit jaar). Met datum: verbruik per uur voor die dag (of per dag/maand met period).',
    inputSchema: {
      date: dateArg.describe('Optioneel: datum JJJJ-MM-DD voor historische data.'),
      period: z.enum(['hours', 'days', 'months', 'years']).optional().describe('Alleen met date: resolutie (standaard "hours").'),
      include_measurements: z.boolean().optional().describe('Ook de losse metingen teruggeven.'),
      connection_uuid: connectionArg,
      raw: z.boolean().optional().describe('Onbewerkt API-antwoord teruggeven.'),
    },
    annotations: READ_ONLY,
  },
  tool(async ({ date, period, include_measurements, connection_uuid, raw }) => {
    const conns = await electricityConnections(connection_uuid);
    const out = [];
    for (const { group, connection } of conns) {
      const base = `/connections/${connection.uuid}/gas`;
      const apiPath = date ? `${base}/charts/${period || 'hours'}?date=${date}` : base;
      const resp = await apiGet(apiPath);
      if (raw) return resp;
      const data = unwrap(resp);
      const groups = data?.measurement_groups;
      out.push({
        adres: formatAddress(group.address),
        aansluiting_uuid: connection.uuid,
        ...(date ? { datum: date, resolutie: period || 'hours' } : {}),
        perioden: Array.isArray(groups)
          ? convertGroups(groups, 'gas', { includeMeasurements: include_measurements ?? Boolean(date) })
          : null,
        ...(Array.isArray(groups) ? {} : { opmerking: 'Geen gasdata gevonden voor deze aansluiting (mogelijk all-electric).' }),
      });
    }
    return out.length === 1 ? out[0] : out;
  }),
);

// --- Zonnepanelen --------------------------------------------------------------

server.registerTool(
  'zonneplan_solar',
  {
    title: 'Zonneplan: zonnepanelen',
    description:
      'Zonnepanelen (omvormer): actueel vermogen, opbrengst vandaag en eerdere perioden, totale opbrengst, aantal panelen/Wp, omvormermodel en eventuele Powerplay-opbrengst.',
    inputSchema: {
      include_measurements: z.boolean().optional().describe('Ook de losse metingen (bijv. per kwartier/uur) teruggeven.'),
      connection_uuid: connectionArg,
      raw: z.boolean().optional().describe('Onbewerkt API-antwoord teruggeven.'),
    },
    annotations: READ_ONLY,
  },
  tool(async ({ include_measurements, connection_uuid, raw }) => {
    const list = await findContracts(CONTRACT.PV, connection_uuid);
    const byConn = new Map();
    for (const c of list) {
      if (!byConn.has(c.connection.uuid)) byConn.set(c.connection.uuid, { ...c, contracts: [] });
      byConn.get(c.connection.uuid).contracts.push(c.contract);
    }
    const out = [];
    for (const { group, connection } of byConn.values()) {
      const resp = await apiGet(`/connections/${connection.uuid}/pv-installation`);
      if (raw) return resp;
      const data = unwrap(resp);
      out.push({
        adres: formatAddress(group.address),
        aansluiting_uuid: connection.uuid,
        installaties: (data?.contracts || byConn.get(connection.uuid).contracts).map((k) => ({
          uuid: k.uuid,
          label: k.label,
          ...convertContractMeta(k.meta),
        })),
        opbrengst: convertGroups(data?.measurement_groups, 'pv', { includeMeasurements: include_measurements ?? false }),
      });
    }
    return out.length === 1 ? out[0] : out;
  }),
);

// --- Thuisbatterij ---------------------------------------------------------------

server.registerTool(
  'zonneplan_battery',
  {
    title: 'Zonneplan: thuisbatterij',
    description:
      'Thuisbatterij (Zonneplan Nexus / Powerplay): laadniveau, vermogen, status, laadcycli, opbrengst vandaag/totaal, geladen/ontladen energie, actieve sturingsmodus (dynamisch laden, zelfconsumptie, thuisoptimalisatie) en optioneel de opbrengst per maand/dag.',
    inputSchema: {
      include_charts: z.boolean().optional().describe('Ook opbrengst per maand (dit jaar) en per dag (deze maand) ophalen.'),
      connection_uuid: connectionArg,
      raw: z.boolean().optional().describe('Onbewerkte API-antwoorden teruggeven.'),
    },
    annotations: READ_ONLY,
  },
  tool(async ({ include_charts, connection_uuid, raw }) => {
    const list = await findContracts(CONTRACT.BATTERY, connection_uuid);
    const out = [];
    for (const { group, connection, contract } of list) {
      const details = await tryGet(`/connections/${connection.uuid}/home-battery-installation/${contract.uuid}`);
      const control = await tryGet(`/api/contracts/${contract.uuid}/home-battery/control-mode`);
      let charts;
      if (include_charts) {
        const now = new Date();
        const today = localDate(now);
        const yearStart = `${today.slice(0, 4)}-01-01`;
        const monthStart = `${today.slice(0, 7)}-01`;
        const months = await tryGet(`/contracts/${contract.uuid}/home_battery_installation/charts/months?date=${yearStart}`);
        const days = await tryGet(`/contracts/${contract.uuid}/home_battery_installation/charts/days?date=${monthStart}`);
        charts = { months, days };
      }
      if (raw) {
        out.push({ contract, details, control, charts });
        continue;
      }
      const battMeta = details.ok ? details.data?.contracts?.find((k) => k.uuid === contract.uuid)?.meta || details.data?.contracts?.[0]?.meta : null;
      const entry = {
        adres: formatAddress(group.address),
        aansluiting_uuid: connection.uuid,
        batterij_uuid: contract.uuid,
        label: contract.label,
        status: convertContractMeta(battMeta || contract.meta),
      };
      if (details.ok && Array.isArray(details.data?.measurement_groups)) {
        entry.perioden = convertGroups(details.data.measurement_groups, 'electricity');
      }
      if (control.ok && control.data) {
        const modes = control.data.modes || {};
        entry.sturing = {
          actieve_modus: control.data.control_mode ?? null,
          modi: Object.fromEntries(
            Object.entries(modes).map(([name, m]) => [name, { beschikbaar: m?.available ?? null, actief: m?.enabled ?? null }]),
          ),
        };
      } else if (!control.ok) {
        entry.sturing = { fout: control.error };
      }
      if (charts) {
        const series = (r) =>
          r.ok
            ? (Array.isArray(r.data) ? r.data : [r.data]).map((s) => ({
                ...(s?.label ? { label: s.label } : {}),
                ...(s?.type ? { type: s.type } : {}),
                waarden: (s?.measurements || []).map((m) => ({
                  datum: m.date ? localTime(m.date).slice(0, 10) : m.date,
                  opbrengst_eur: toEur(m.value),
                  ...(m.meta ? { meta: convertGroupMeta(m.meta) } : {}),
                })),
              }))
            : { fout: r.error };
        entry.opbrengst_per_maand_dit_jaar = series(charts.months);
        entry.opbrengst_per_dag_deze_maand = series(charts.days);
      }
      out.push(entry);
    }
    return out.length === 1 ? out[0] : out;
  }),
);

// --- Laadpaal -------------------------------------------------------------------

server.registerTool(
  'zonneplan_charge_point',
  {
    title: 'Zonneplan: laadpaal',
    description: 'Status van de Zonneplan-laadpaal: laadstatus, vermogen, sessies en instellingen (alleen lezen).',
    inputSchema: {
      connection_uuid: connectionArg,
    },
    annotations: READ_ONLY,
  },
  tool(async ({ connection_uuid }) => {
    const list = await findContracts(CONTRACT.CHARGE_POINT, connection_uuid);
    const out = [];
    for (const { connection, contract } of list) {
      const resp = await apiGet(`/connections/${connection.uuid}/charge-points/${contract.uuid}`);
      out.push({ laadpaal_uuid: contract.uuid, label: contract.label, data: unwrap(resp) });
    }
    return out.length === 1 ? out[0] : out;
  }),
);

// --- Prijzen ----------------------------------------------------------------------

function priceSeries(chartData) {
  const prices = chartData?.chart?.series?.prices || [];
  return prices.map((p) => ({
    start_iso: p.start_date,
    end_iso: p.end_date,
    start: localTime(p.start_date),
    eind: localTime(p.end_date),
    incl_btw: toEurPrecise(p.price_tax_included?.amount),
    excl_btw: toEurPrecise(p.price_tax_excluded?.amount),
    ...(p.tariff_group ? { tariefgroep: p.tariff_group } : {}),
    ...(isNum(p.sustainability_score?.permille) ? { duurzaamheid_pct: round(p.sustainability_score.permille / 10, 1) } : {}),
  }));
}

server.registerTool(
  'zonneplan_prices',
  {
    title: 'Zonneplan: dynamische energieprijzen',
    description:
      'Dynamische stroom- of gasprijzen van Zonneplan (incl. en excl. btw, in €/kWh of €/m³): huidige prijs, goedkoopste en duurste moment, en de prijzen voor vandaag en (indien al bekend, meestal na ±13:00) morgen.',
    inputSchema: {
      energy: z.enum(['electricity', 'gas']).optional().describe('"electricity" (standaard) of "gas".'),
      resolution: z
        .enum(['hour', 'quarter'])
        .optional()
        .describe('Alleen stroom: per uur (standaard) of per kwartier.'),
      day: z.enum(['today', 'tomorrow', 'all']).optional().describe('Welke dag(en) in de lijst opnemen. Standaard "all".'),
    },
    annotations: READ_ONLY,
  },
  tool(async ({ energy = 'electricity', resolution = 'hour', day = 'all' }) => {
    const chart = energy === 'gas' ? 'gas-daily' : resolution === 'quarter' ? 'electricity-quarter-hourly' : 'electricity-hourly';
    const data = unwrap(await apiGet(`/api/consumer-prices/charts/${chart}`));
    const series = priceSeries(data);
    if (!series.length) throw new ZonneplanError('Geen prijsdata ontvangen van Zonneplan.');

    const now = Date.now();
    const today = localDate();
    const tomorrow = localDate(new Date(now + 24 * 3600 * 1000));
    const current = series.find((p) => new Date(p.start_iso).getTime() <= now && now < new Date(p.end_iso).getTime());

    const summarize = (items) => {
      if (!items.length) return null;
      const sorted = [...items].sort((a, b) => a.incl_btw - b.incl_btw);
      const avg = items.reduce((s, p) => s + (p.incl_btw || 0), 0) / items.length;
      const strip = ({ start_iso, end_iso, ...rest }) => rest;
      return {
        goedkoopst: strip(sorted[0]),
        duurst: strip(sorted[sorted.length - 1]),
        gemiddeld_incl_btw: round(avg, 5),
        aantal: items.length,
      };
    };

    const ofDay = (d) => series.filter((p) => p.start.slice(0, 10) === d);
    const filtered = day === 'today' ? ofDay(today) : day === 'tomorrow' ? ofDay(tomorrow) : series;
    const strip = ({ start_iso, end_iso, ...rest }) => rest;

    return {
      energie: energy,
      eenheid: energy === 'gas' ? '€/m³' : '€/kWh',
      resolutie: energy === 'gas' ? 'dag' : resolution === 'quarter' ? 'kwartier' : 'uur',
      nu: current ? strip(current) : null,
      vandaag: summarize(ofDay(today)),
      vanaf_nu: summarize(series.filter((p) => new Date(p.end_iso).getTime() > now)),
      morgen: summarize(ofDay(tomorrow)) || 'Nog niet bekend',
      prijzen: filtered.map(strip),
    };
  }),
);

// --- Ruwe API (verkennen) ------------------------------------------------------------

server.registerTool(
  'zonneplan_api_get',
  {
    title: 'Zonneplan: ruwe API-aanroep (GET)',
    description:
      'Geavanceerd: voer een willekeurige GET-request uit op app-api.zonneplan.nl en krijg het onbewerkte antwoord. Handig als een ander tool niet de gewenste data geeft. Bekende paden: /user-accounts/me, /connections/{aansluiting}/summary, /connections/{aansluiting}/electricity-delivered, /connections/{aansluiting}/electricity-delivered/charts/hours?date=JJJJ-MM-DD, /connections/{aansluiting}/electricity-home-consumption, /connections/{aansluiting}/gas, /connections/{aansluiting}/pv-installation, /connections/{aansluiting}/home-battery-installation/{batterij}, /contracts/{batterij}/home_battery_installation/charts/months?date=JJJJ-01-01, /api/contracts/{batterij}/home-battery/control-mode, /api/consumer-prices/charts/electricity-hourly. Bedragen staan in 1e-7 euro, energie in Wh, gas in dm³.',
    inputSchema: {
      path: z
        .string()
        .regex(/^\/[A-Za-z0-9\-_/.?=&%:]*$/, 'Pad moet met / beginnen en mag geen host bevatten')
        .refine((p) => !p.includes('..') && !p.includes('//'), 'Ongeldig pad')
        .describe('Pad inclusief querystring, bijv. /connections/<uuid>/summary'),
    },
    annotations: READ_ONLY,
  },
  tool(async ({ path: apiPath }) => apiGet(apiPath)),
);

// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`Gestart (v${SERVER_VERSION}); tokens in ${STATE_DIR}`);
}

main().catch((err) => {
  log('Fatale fout:', err);
  process.exit(1);
});
