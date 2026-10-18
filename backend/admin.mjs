// Administration of the entitlement server. Runs on the server (or your trusted computer); there is deliberately no HTTP admin API.
//   node backend/admin.mjs init                          create the signing key + pepper in the secrets folder (once)
//   node backend/admin.mjs sync-app-key                  copy the PUBLIC key into www/js/entitlement-config.js
//   node backend/admin.mjs generate --batch NAME [--plan 15d:5,3m:5,lifetime:5] [--valid-days 365] [--out FILE]
//                                                        create codes, store only their hashes, write the plain codes to FILE (once)
//   node backend/admin.mjs list                          codes with type / status / redemptions (never the codes themselves)
//   node backend/admin.mjs disable <id> | enable <id>
// Environment: MYDOCS_DB, MYDOCS_SECRETS (same as server.mjs)
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { openStore, DAY_MS } from './lib/store.mjs';
import { generateCode, hashCode, normalizeCode, TYPES } from './lib/codes.mjs';
import { generateSigningKey, publicJwk } from './lib/tokens.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const secrets = () => process.env.MYDOCS_SECRETS ?? join(here, '.secrets');
const dbFile = () => process.env.MYDOCS_DB ?? join(here, 'data', 'mydocs.sqlite');
const configFile = join(here, '..', 'www', 'js', 'entitlement-config.js');

function flags(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { out[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true; } else out._.push(args[i]);
  }
  return out;
}
const secret = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text, { mode: 0o600 }); try { chmodSync(file, 0o600); } catch { /* not supported on this file system */ } };

export function init({ force = false } = {}) {
  const dir = secrets();
  const key = join(dir, 'signing-key.pem');
  if (existsSync(key) && !force) throw new Error('A signing key already exists. Pass --force to replace it (all previously issued tokens would stop working).');
  const pem = generateSigningKey();
  secret(key, pem);
  secret(join(dir, 'pepper.txt'), `${randomBytes(32).toString('hex')}\n`);
  const jwk = publicJwk(pem);
  writeFileSync(join(dir, 'public-key.json'), `${JSON.stringify(jwk, null, 2)}\n`);
  return jwk;
}

export function syncAppKey() {
  const jwk = JSON.parse(readFileSync(join(secrets(), 'public-key.json'), 'utf8'));
  const text = readFileSync(configFile, 'utf8');
  const next = text.replace(/(\/\/ BEGIN public-key\r?\n)[\s\S]*?(\r?\n\/\/ END public-key)/, `$1export const SIGNING_PUBLIC_KEY = ${JSON.stringify(jwk)};$2`);
  if (next === text && !text.includes(JSON.stringify(jwk))) throw new Error('Markers not found in entitlement-config.js');
  writeFileSync(configFile, next);
  return jwk;
}

/** Creates codes; returns [{ id, type, code }] (the plain codes exist only in this return value and in the output file). */
export function generate({ batch, plan, validDays = 365, store, pepper, now = Date.now() }) {
  const created = [];
  for (const [type, count] of plan) {
    for (let i = 0; i < count; i++) {
      const code = generateCode(type);
      const id = randomUUID();
      store.addCode({ id, codeHash: hashCode(normalizeCode(code), pepper), type, validUntil: validDays ? now + validDays * DAY_MS : null, maxRedemptions: 1, batch, createdAt: now });
      created.push({ id, type, code });
    }
  }
  return created;
}

export const parsePlan = (text) => String(text).split(',').map((part) => {
  const [type, count] = part.split(':');
  if (!TYPES[type] || !/^\d+$/.test(count ?? '')) throw new Error(`Bad plan entry: ${part}`);
  return [type, Number(count)];
});

function main(argv) {
  const [command, ...rest] = argv;
  const f = flags(rest);
  if (command === 'init') {
    const jwk = init({ force: Boolean(f.force) });
    console.log(`Created ${secrets()} (signing-key.pem and pepper.txt are SECRET: keep them private, back them up, never commit them).`);
    console.log('Public key (safe to publish):', JSON.stringify(jwk));
    console.log('Next: node backend/admin.mjs sync-app-key');
  } else if (command === 'sync-app-key') {
    console.log('Updated www/js/entitlement-config.js with the public key:', JSON.stringify(syncAppKey()));
  } else if (command === 'generate') {
    if (!f.batch || f.batch === true) throw new Error('--batch NAME is required');
    const plan = parsePlan(f.plan ?? '15d:5,3m:5,lifetime:5');
    const store = openStore(dbFile());
    const pepper = readFileSync(join(secrets(), 'pepper.txt'), 'utf8').trim();
    const codes = generate({ batch: f.batch, plan, validDays: f['valid-days'] === undefined ? 365 : Number(f['valid-days']), store, pepper });
    store.close();
    const out = resolve(typeof f.out === 'string' ? f.out : join(secrets(), `promo-codes-${f.batch}.txt`));
    const lines = [`MyDocs promo codes, batch "${f.batch}", generated ${new Date().toISOString()}`, 'Each code can be redeemed once. Keep this file private; the server stores only hashes.', ''];
    for (const type of Object.keys(TYPES)) {
      const group = codes.filter((c) => c.type === type);
      if (group.length) lines.push(`${TYPES[type].label} (${group.length})`, ...group.map((c) => `  ${c.code}`), '');
    }
    secret(out, `${lines.join('\n')}\n`);
    console.log(`Generated ${codes.length} codes (${plan.map(([t, n]) => `${n} x ${TYPES[t].label}`).join(', ')}).`);
    console.log(`Plain codes written ONCE to ${out} (owner-only file). They are not stored anywhere else and not shown here.`);
  } else if (command === 'list') {
    const store = openStore(dbFile());
    console.table(store.list().map((c) => ({ id: c.id.slice(0, 8), type: c.type, status: c.status, redemptions: `${c.redemptions}/${c.maxRedemptions}`, validUntil: c.validUntil ? new Date(c.validUntil).toISOString().slice(0, 10) : 'never', batch: c.batch })));
    store.close();
  } else if (command === 'disable' || command === 'enable') {
    const id = f._[0];
    const store = openStore(dbFile());
    const match = store.list().find((c) => c.id === id || c.id.startsWith(id ?? '\0'));
    if (!match) throw new Error('No such code id');
    store.setStatus(match.id, command === 'disable' ? 'disabled' : 'active');
    store.close();
    console.log(`${command}d ${match.id}`);
  } else {
    console.log('Commands: init | sync-app-key | generate --batch NAME [--plan 15d:5,3m:5,lifetime:5] [--valid-days 365] [--out FILE] | list | disable <id> | enable <id>');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
}
