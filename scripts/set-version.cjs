#!/usr/bin/env node
// Zet het versienummer in package.json en bundle/manifest.json.
// Gebruik: node scripts/set-version.cjs 1.2.3   (een voorloop-"v" mag ook)
const fs = require('fs');
const path = require('path');

const raw = process.argv[2];
const version = (raw || '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Ongeldige versie: "${raw}". Verwacht bijv. 1.2.3 of v1.2.3`);
  process.exit(1);
}

for (const rel of ['package.json', 'bundle/manifest.json']) {
  const file = path.join(__dirname, '..', rel);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.version = version;
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
  console.log(`${rel} → ${version}`);
}

const lock = path.join(__dirname, '..', 'package-lock.json');
if (fs.existsSync(lock)) {
  const json = JSON.parse(fs.readFileSync(lock, 'utf8'));
  json.version = version;
  if (json.packages && json.packages['']) json.packages[''].version = version;
  fs.writeFileSync(lock, JSON.stringify(json, null, 2) + '\n');
  console.log(`package-lock.json → ${version}`);
}
