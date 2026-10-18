// Basic / Pro access: the access policy, entitlement state (promo, Play, expiry, priority), document / size / backup gating at the
// service boundary, the promo backend (codes, hashing, atomic redemption, API), the Play verifier (fake Google), billing and the
// promo client. No network, no Google account, no real purchase: everything external is a small fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccessPolicy, EntitlementError, PLAN, BASIC_LIMITS, UNRESTRICTED_ACCESS } from '../www/js/access.js';
import { createEntitlements, addCalendarMonths, DAY_MS, ENTITLEMENT_KEY } from '../www/js/entitlements.js';
import { importPublicKey } from '../www/js/entitlement-token.js';
import { createBilling, BillingError } from '../www/js/billing.js';
import { createPromoClient, PromoError, isBackendConfigured } from '../www/js/promo.js';
import { errorText, setLanguage } from '../www/js/i18n.js';
import en from '../www/js/locales/en.js';
import hi from '../www/js/locales/hi.js';
import { generateSigningKey, publicJwk, signToken, verifySigned } from '../backend/lib/tokens.mjs';
import { generateCode, normalizeCode, hashCode } from '../backend/lib/codes.mjs';
import { openStore, addCalendarMonths as serverMonths } from '../backend/lib/store.mjs';
import { createApi, createLimiter } from '../backend/lib/api.mjs';
import { createPlayVerifier, PlayError } from '../backend/lib/play.mjs';
import { generate, parsePlan } from '../backend/admin.mjs';
import { makeApp, pdf, cleanupTemp } from './helpers/backup-env.mjs';
import { setSizeLimitMb } from '../www/js/sizelimit.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const PEM = generateSigningKey();
const JWK = publicJwk(PEM);
const PEPPER = 'test-pepper';
const DEVICE = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);

const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
const token = (over = {}) => signToken({ v: 1, kind: 'promo', type: '15d', id: 'c1', deviceId: DEVICE, iat: T0, exp: T0 + 15 * DAY_MS, ...over }, PEM);

async function makeEntitlements({ storage = memStore(), clock = { t: T0 }, deviceId = DEVICE } = {}) {
  const e = createEntitlements({ storage, now: () => clock.t, publicKey: importPublicKey(JWK), deviceId: () => deviceId });
  await e.init();
  return { e, storage, clock };
}

/* ---------- access policy ---------- */

test('Basic limits: 5 documents, 3 MB, no Backup / Drive; Pro: everything', () => {
  const basic = createAccessPolicy(() => ({ plan: PLAN.BASIC }));
  const pro = createAccessPolicy(() => ({ plan: PLAN.PRO }));
  assert.deepEqual(BASIC_LIMITS, { maxDocuments: 5, maxSizeMb: 3 });
  assert.equal(basic.canCreateDocument(4), true);
  assert.equal(basic.canCreateDocument(5), false);
  assert.equal(basic.canCreateDocument(9), false); // more than 5 exist (a lapsed Pro): still blocked
  assert.throws(() => basic.assertCanCreateDocument(5), (e) => e instanceof EntitlementError && e.code === 'DOCUMENT_LIMIT');
  assert.equal(basic.sizeCapMb(), 3);
  assert.equal(basic.isSizeAllowed(5), false);
  assert.throws(() => basic.requirePro('backup'), (e) => e.code === 'PRO_REQUIRED');
  assert.throws(() => basic.requirePro('drive'), (e) => e.code === 'PRO_REQUIRED');
  assert.equal(basic.canUse('backup'), false);
  assert.equal(pro.canCreateDocument(10_000), true);
  assert.equal(pro.sizeCapMb(), null);
  assert.doesNotThrow(() => pro.requirePro('backup'));
  assert.equal(UNRESTRICTED_ACCESS.isPro(), true);
});

/* ---------- entitlements: promo, Play, priority, expiry ---------- */

test('a server-signed promo token unlocks Pro until its expiry, then Basic returns; nothing is lost', async () => {
  const { e, clock } = await makeEntitlements();
  assert.equal(e.isPro(), false);
  assert.ok(await e.grantPromo(token()));
  assert.equal(e.isPro(), true);
  assert.deepEqual([e.effective().source, e.effective().type, e.effective().expiresAt], ['promo', '15d', T0 + 15 * DAY_MS]);
  clock.t = T0 + 15 * DAY_MS - 1;
  assert.equal(e.isPro(), true);
  clock.t = T0 + 15 * DAY_MS;
  assert.equal(e.isPro(), false);
});

test('forged, tampered, wrong-device, wrong-key and already-expired tokens grant nothing', async () => {
  const { e } = await makeEntitlements();
  const good = token();
  const [body, sig] = good.split('.');
  const tamperedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), type: 'lifetime', exp: null })).toString('base64url');
  assert.equal(await e.grantPromo(`${tamperedBody}.${sig}`), null);
  assert.equal(await e.grantPromo(token({ deviceId: OTHER })), null);
  assert.equal(await e.grantPromo(signToken({ v: 1, kind: 'promo', type: 'lifetime', id: 'x', deviceId: DEVICE, iat: T0, exp: null }, generateSigningKey())), null);
  assert.equal(await e.grantPromo(token({ iat: T0 - 30 * DAY_MS, exp: T0 - 1 })), null);
  assert.equal(await e.grantPromo('garbage'), null);
  assert.equal(await e.grantPromo(''), null);
  assert.equal(e.isPro(), false);
});

test('priority: lifetime promo beats everything, the longest temporary promo wins, expiry of one never downgrades another', async () => {
  const { e, clock } = await makeEntitlements();
  await e.grantPromo(token({ id: 'a', type: '15d', exp: T0 + 15 * DAY_MS }));
  await e.grantPromo(token({ id: 'b', type: '3m', exp: addCalendarMonths(T0, 3) }));
  assert.equal(e.effective().type, '3m');
  clock.t = T0 + 16 * DAY_MS; // the short one is over, the long one stands
  assert.equal(e.isPro(), true);
  assert.equal(e.effective().expiresAt, addCalendarMonths(T0, 3));
  await e.grantPromo(token({ id: 'c', type: 'lifetime', exp: null }));
  assert.equal(e.effective().lifetime, true);
  clock.t = T0 + 4000 * DAY_MS;
  assert.equal(e.isPro(), true); // lifetime promo never expires
  e.grantPlayClient(clock.t);
  assert.equal(e.effective().source, 'play'); // a purchase outranks a promo
});

test('a purchase and a temporary promo together: when the promo ends, the purchase keeps Pro', async () => {
  const { e, clock } = await makeEntitlements();
  await e.grantPromo(token());
  e.grantPlayClient(T0);
  clock.t = T0 + 20 * DAY_MS;
  assert.equal(e.isPro(), true);
  assert.equal(e.effective().source, 'play');
});

test('redeeming the same promo again never adds time', async () => {
  const { e } = await makeEntitlements();
  await e.grantPromo(token({ id: 'same' }));
  await e.grantPromo(token({ id: 'same' }));
  assert.equal(e.effective().expiresAt, T0 + 15 * DAY_MS);
});

test('calendar months: 3 months from 31 Oct is 31 Jan, month-end days are clamped, leap years work; server and app agree', () => {
  const d = (y, m, day) => Date.UTC(y, m - 1, day, 9, 30);
  assert.equal(addCalendarMonths(d(2026, 10, 31), 3), d(2027, 1, 31));
  assert.equal(addCalendarMonths(d(2026, 11, 30), 3), d(2027, 2, 28));
  assert.equal(addCalendarMonths(d(2027, 11, 30), 3), d(2028, 2, 29));
  assert.equal(addCalendarMonths(d(2026, 12, 15), 3), d(2027, 3, 15));
  for (const ms of [d(2026, 1, 31), d(2026, 8, 31), d(2028, 11, 30)]) assert.equal(addCalendarMonths(ms, 3), serverMonths(ms, 3));
});

test('state survives a restart; edited storage is not trusted; a rolled-back clock does not revive an ended entitlement', async () => {
  const storage = memStore();
  const clock = { t: T0 };
  const first = await makeEntitlements({ storage, clock });
  await first.e.grantPromo(token());
  const again = await makeEntitlements({ storage, clock });
  assert.equal(again.e.isPro(), true); // restored after restart

  const saved = JSON.parse(storage.getItem(ENTITLEMENT_KEY));
  saved.promos = [token({ type: 'lifetime', exp: null, id: 'fake' }).replace(/\.(.)/, (_, c) => `.${c === 'A' ? 'B' : 'A'}`)]; // first signature character (the last one has unused bits)
  storage.setItem(ENTITLEMENT_KEY, JSON.stringify(saved));
  assert.equal((await makeEntitlements({ storage, clock })).e.isPro(), false); // forged entry rejected

  const s2 = memStore();
  const c2 = { t: T0 };
  const m = await makeEntitlements({ storage: s2, clock: c2 });
  await m.e.grantPromo(token());
  c2.t = T0 + 16 * DAY_MS;
  assert.equal(m.e.isPro(), false);
  c2.t = T0 + 1 * DAY_MS; // the user winds the clock back
  assert.equal(m.e.isPro(), false);
  assert.equal((await makeEntitlements({ storage: s2, clock: c2 })).e.isPro(), false); // also after a restart
});

test('Play entitlement: client mode has a grace period, a refund removes it, a server token expires unless refreshed', async () => {
  const { e, clock } = await makeEntitlements();
  e.grantPlayClient(T0);
  clock.t = T0 + 29 * DAY_MS;
  assert.equal(e.isPro(), true);
  clock.t = T0 + 31 * DAY_MS; // not re-verified for longer than the grace period
  assert.equal(e.isPro(), false);
  e.grantPlayClient(clock.t);
  assert.equal(e.isPro(), true);
  e.revokePlay();
  assert.equal(e.isPro(), false);
  const playToken = signToken({ v: 1, kind: 'play', type: 'lifetime', id: 'play:1', deviceId: DEVICE, iat: clock.t, exp: clock.t + 30 * DAY_MS }, PEM);
  assert.ok(await e.grantPlayServer(playToken));
  assert.equal(e.isPro(), true);
  clock.t += 31 * DAY_MS;
  assert.equal(e.isPro(), false);
});

test('subscribers hear about a change once, and about an expiry through tick()', async () => {
  const { e, clock } = await makeEntitlements();
  const seen = [];
  e.subscribe((x) => seen.push(x.plan));
  await e.grantPromo(token());
  await e.grantPromo(token({ id: 'again' }));
  clock.t = T0 + 20 * DAY_MS;
  e.tick();
  e.tick();
  assert.deepEqual(seen, ['pro', 'basic']);
  assert.ok(e.msUntilExpiry() === null);
});

/* ---------- gating at the service boundary ---------- */

const accessFor = (state) => createAccessPolicy(() => ({ plan: state.plan }));

test('Basic: the 6th document is refused whatever the category, source, rename or restart; Pro is unlimited', async () => {
  const state = { plan: PLAN.BASIC };
  setSizeLimitMb(15);
  const app = await makeApp({ access: accessFor(state) });
  const cats = await app.docs.listCategories();
  for (let i = 0; i < 5; i++) await app.docs.importFile(cats[i % cats.length].id, pdf(`f${i}.pdf`), `Doc ${i}`);
  await assert.rejects(app.docs.importFile(cats[0].id, pdf('x.pdf'), 'Sixth'), (e) => e.code === 'DOCUMENT_LIMIT');
  await assert.rejects(app.docs.importFile(cats[7].id, pdf('x.pdf'), 'Elsewhere'), (e) => e.code === 'DOCUMENT_LIMIT'); // other category
  await assert.rejects(app.docs.importFile(cats[0].id, { ...pdf('c.jpg'), name: 'c.jpg', mimeType: 'image/jpeg', source: 'camera' }, 'Photo'), (e) => e.code === 'DOCUMENT_LIMIT'); // camera path
  assert.equal(await app.docs.countDocuments(), 5);
  const first = (await app.docs.listAll())[0];
  await app.docs.rename?.(first.id, 'Renamed'); // renaming does not free a slot
  await assert.rejects(app.docs.importFile(cats[0].id, pdf('x.pdf'), 'Still no'), (e) => e.code === 'DOCUMENT_LIMIT');
  state.plan = PLAN.PRO;
  for (let i = 0; i < 4; i++) await app.docs.importFile(cats[0].id, pdf(`p${i}.pdf`), `Pro ${i}`);
  assert.equal(await app.docs.countDocuments(), 9);
  state.plan = PLAN.BASIC; // Pro ends: all 9 stay, nothing new until fewer than 5
  assert.equal((await app.docs.listAll()).filter((d) => !d.isDemo).length, 9);
  await assert.rejects(app.docs.importFile(cats[0].id, pdf('x.pdf'), 'Blocked'), (e) => e.code === 'DOCUMENT_LIMIT');
  for (const d of (await app.docs.listAll()).filter((x) => !x.isDemo).slice(0, 5)) await app.docs.remove(d.id); // deleting is always allowed
  assert.equal(await app.docs.countDocuments(), 4);
  await app.docs.importFile(cats[0].id, pdf('ok.pdf'), 'Fits again');
  assert.equal(await app.docs.countDocuments(), 5);
});

test('Basic: documents over 3 MB are refused (upload and camera) even when the saved limit is 15 MB; Pro honours the saved limit', async () => {
  const state = { plan: PLAN.BASIC };
  setSizeLimitMb(15);
  const app = await makeApp({ access: accessFor(state) });
  const cat = (await app.docs.listCategories())[0].id;
  const big = (name, extra = {}) => ({ name, mimeType: 'application/pdf', size: 3_500_000, data: Buffer.alloc(3_500_000, 65).toString('base64'), ...extra });
  await assert.rejects(app.docs.importFile(cat, big('big.pdf'), 'Big'), (e) => /FILE_TOO_LARGE/.test(e.code));
  await assert.rejects(app.docs.importFile(cat, big('big.jpg', { mimeType: 'image/jpeg', source: 'camera' }), 'Big photo'), (e) => /FILE_TOO_LARGE/.test(e.code));
  await app.docs.importFile(cat, { ...big('ok.pdf'), size: 2_900_000, data: Buffer.alloc(2_900_000, 65).toString('base64') }, 'Fits');
  state.plan = PLAN.PRO;
  await app.docs.importFile(cat, big('big2.pdf'), 'Big now fits');
  setSizeLimitMb(5);
});

test('Backup, restore and Drive upload are refused at the service for Basic, and work for Pro', async () => {
  const state = { plan: PLAN.PRO };
  const app = await makeApp({ access: accessFor(state) });
  const cat = (await app.docs.listCategories())[0].id;
  await app.docs.importFile(cat, pdf('a.pdf'), 'A');
  const created = await app.backup.createBackup();
  assert.ok(created.size > 0);
  state.plan = PLAN.BASIC;
  await assert.rejects(app.backup.createBackup(), (e) => e.code === 'PRO_REQUIRED');
  await assert.rejects(app.backup.inspect(created.path), (e) => e.code === 'PRO_REQUIRED');
  await assert.rejects(app.backup.restore(created.path, { mode: 'merge' }), (e) => e.code === 'PRO_REQUIRED');
  const { createDriveClient } = await import('../www/js/drive.js');
  const drive = createDriveClient({ authorize: async () => 'tok', fetchImpl: async () => { throw new Error('network must not be reached'); }, access: accessFor(state) });
  await assert.rejects(drive.upload({ name: 'x.mydocsbackup', size: 1, readRange: async () => new Uint8Array(1) }), (e) => e.code === 'PRO_REQUIRED');
  assert.equal(await app.docs.countDocuments(), 1); // nothing was touched
});

/* ---------- promo codes: generation, storage, redemption ---------- */

test('generated codes: 15 in total (5 per type), the documented formats, unique, only hashes are stored', () => {
  const store = openStore(':memory:');
  const created = generate({ batch: 'launch', plan: parsePlan('15d:5,3m:5,lifetime:5'), store, pepper: PEPPER, now: T0 });
  assert.equal(created.length, 15);
  for (const [type, re] of [['15d', /^MD15-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/], ['3m', /^MD3M-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/], ['lifetime', /^MDLT-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/]]) {
    const of = created.filter((c) => c.type === type);
    assert.equal(of.length, 5);
    for (const c of of) assert.match(c.code, re);
  }
  assert.equal(new Set(created.map((c) => c.code)).size, 15);
  const dump = JSON.stringify(store.db.prepare('SELECT * FROM promo_codes').all());
  for (const c of created) assert.ok(!dump.includes(c.code) && !dump.includes(c.code.replace(/-/g, '')), 'a plain code is stored');
  assert.ok(!JSON.stringify(store.list()).includes(created[0].code));
  assert.equal(store.list().length, 15);
  assert.ok(store.list().every((r) => r.maxRedemptions === 1));
  assert.throws(() => parsePlan('bogus:1'));
});

test('code normalisation: case, spaces and dashes are forgiven; lookalike or malformed codes are not codes', () => {
  const code = generateCode('3m');
  assert.equal(normalizeCode(code.toLowerCase()), code);
  assert.equal(normalizeCode(` ${code.replace(/-/g, ' ')} `), code);
  for (const bad of ['', null, 'MD15', 'XXXX-AAAA-BBBB-CCCC', 'MD15-AAAA-BBBB-CCC0', 'MD15-AAAA-BBBB-CCCCC', 'MD15-AAAA-BBBB-CCCI']) assert.equal(normalizeCode(bad), null);
  assert.notEqual(hashCode(code, 'one'), hashCode(code, 'two')); // the hash depends on the secret
});

function backendWith(codes = '15d:1,3m:1,lifetime:1', clock = { t: T0 }) {
  const store = openStore(':memory:');
  const created = generate({ batch: 't', plan: parsePlan(codes), store, pepper: PEPPER, now: clock.t });
  const api = createApi({ store, privateKeyPem: PEM, pepper: PEPPER, now: () => clock.t, limiter: createLimiter({ max: 5, now: () => clock.t }) });
  const call = (path, body, method = 'POST', ip = '1.1.1.1') => api.handle({ method, path, body, ip });
  return { store, created, api, call, clock, codeOf: (type) => created.find((c) => c.type === type).code };
}

test('redeeming: each type gets the right expiry; the answer is signed and verifiable with the public key only', async () => {
  const b = backendWith();
  const r15 = await b.call('/v1/promo/redeem', { code: b.codeOf('15d'), deviceId: DEVICE });
  assert.equal(r15.status, 200);
  const p15 = verifySigned(r15.body.token, JWK);
  assert.deepEqual([p15.type, p15.exp, p15.deviceId], ['15d', T0 + 15 * DAY_MS, DEVICE]);
  const p3 = verifySigned((await b.call('/v1/promo/redeem', { code: b.codeOf('3m').toLowerCase(), deviceId: DEVICE })).body.token, JWK);
  assert.equal(p3.exp, addCalendarMonths(T0, 3));
  const pl = verifySigned((await b.call('/v1/promo/redeem', { code: b.codeOf('lifetime'), deviceId: DEVICE })).body.token, JWK);
  assert.equal(pl.exp, null);
});

test('single use: a second device is refused, the same device gets the same entitlement back (never extended)', async () => {
  const b = backendWith('15d:1');
  const code = b.codeOf('15d');
  const first = await b.call('/v1/promo/redeem', { code, deviceId: DEVICE });
  b.clock.t = T0 + 5 * DAY_MS;
  const other = await b.call('/v1/promo/redeem', { code, deviceId: OTHER });
  assert.deepEqual([other.status, other.body.error], [409, 'ALREADY_REDEEMED']);
  const repeat = await b.call('/v1/promo/redeem', { code, deviceId: DEVICE });
  assert.equal(repeat.body.repeat, true);
  assert.equal(verifySigned(repeat.body.token, JWK).exp, verifySigned(first.body.token, JWK).exp); // not 5 days later
  b.clock.t = T0 + 16 * DAY_MS; // the entitlement it gave is over: the code does not start again
  assert.equal((await b.call('/v1/promo/redeem', { code, deviceId: DEVICE })).body.error, 'ENTITLEMENT_EXPIRED');
});

test('concurrent redemption of one code by many devices: exactly one wins', async () => {
  const b = backendWith('lifetime:1');
  const code = b.codeOf('lifetime');
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => b.call('/v1/promo/redeem', { code, deviceId: `dev${String(i).padStart(20, '0')}` }, 'POST', `9.9.9.${i}`)));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.body.error === 'ALREADY_REDEEMED').length, 19);
  assert.equal(b.store.db.prepare('SELECT COUNT(*) AS n FROM redemptions').get().n, 1);
});

test('invalid, disabled and unused-but-expired codes give distinct errors; errors never grant a token', async () => {
  const b = backendWith('15d:2');
  const [a, c] = b.created;
  const miss = await b.call('/v1/promo/redeem', { code: 'MD15-AAAA-BBBB-CCCC', deviceId: DEVICE });
  assert.deepEqual([miss.status, miss.body.error, 'token' in miss.body], [404, 'INVALID_CODE', false]);
  assert.equal((await b.call('/v1/promo/redeem', { code: 'nonsense', deviceId: DEVICE })).body.error, 'INVALID_CODE');
  b.store.setStatus(a.id, 'disabled');
  assert.equal((await b.call('/v1/promo/redeem', { code: a.code, deviceId: DEVICE })).body.error, 'DISABLED');
  b.clock.t = T0 + 400 * DAY_MS; // past the code's own validity window (365 days)
  assert.equal((await b.call('/v1/promo/redeem', { code: c.code, deviceId: DEVICE })).body.error, 'CODE_EXPIRED');
  assert.equal((await b.call('/v1/promo/redeem', { code: c.code, deviceId: 'short' })).body.error, 'BAD_REQUEST');
});

test('brute force is rate-limited, and there are no HTTP endpoints that list or create codes', async () => {
  const b = backendWith('15d:1');
  for (let i = 0; i < 5; i++) assert.equal((await b.call('/v1/promo/redeem', { code: `MD15-AAAA-BBBB-CC${i + 2}2`, deviceId: DEVICE })).body.error, 'INVALID_CODE');
  const blocked = await b.call('/v1/promo/redeem', { code: b.codeOf('15d'), deviceId: DEVICE });
  assert.deepEqual([blocked.status, blocked.body.error], [429, 'RATE_LIMITED']);
  b.clock.t += 11 * 60_000;
  assert.equal((await b.call('/v1/promo/redeem', { code: b.codeOf('15d'), deviceId: DEVICE })).status, 200);
  for (const path of ['/v1/promo/list', '/v1/promo/generate', '/v1/admin/codes', '/v1/promo/disable']) {
    assert.equal((await b.call(path, { deviceId: DEVICE })).status, 400);
    assert.equal((await b.call(path, null, 'GET')).status, 400);
  }
  assert.equal(createApi.length, 1);
});

test('restore after reinstall: the device gets its still-active promo entitlements back, signed again', async () => {
  const b = backendWith();
  await b.call('/v1/promo/redeem', { code: b.codeOf('3m'), deviceId: DEVICE });
  await b.call('/v1/promo/redeem', { code: b.codeOf('15d'), deviceId: DEVICE });
  const res = await b.call('/v1/promo/restore', { deviceId: DEVICE });
  assert.equal(res.body.tokens.length, 2);
  assert.deepEqual((await b.call('/v1/promo/restore', { deviceId: OTHER })).body.tokens, []);
  b.clock.t = T0 + 20 * DAY_MS; // the 15-day one is over
  assert.equal((await b.call('/v1/promo/restore', { deviceId: DEVICE })).body.tokens.length, 1);
  b.store.setStatus(b.created.find((c) => c.type === '3m').id, 'disabled');
  assert.equal((await b.call('/v1/promo/restore', { deviceId: DEVICE })).body.tokens.length, 0);
});

test('the promo client + entitlements end to end against the real API logic; the client never fakes success', async () => {
  const b = backendWith();
  const fetchImpl = async (url, init) => {
    const r = await b.api.handle({ method: init.method, path: new URL(url).pathname, body: JSON.parse(init.body), ip: '2.2.2.2' });
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  const { e } = await makeEntitlements({ clock: b.clock });
  const client = createPromoClient({ baseUrl: 'http://localhost:8787', deviceId: () => DEVICE, entitlements: e, fetchImpl });
  await assert.rejects(client.redeem('  '), (err) => err.code === 'EMPTY');
  await assert.rejects(client.redeem('MD15-AAAA-BBBB-CCCC'), (err) => err instanceof PromoError && err.code === 'INVALID_CODE');
  assert.equal(e.isPro(), false);
  const ok = await client.redeem(b.codeOf('3m'));
  assert.deepEqual([ok.type, ok.expiresAt], ['3m', addCalendarMonths(T0, 3)]);
  assert.equal(e.isPro(), true);
  const life = await client.redeem(b.codeOf('lifetime'));
  assert.equal(life.expiresAt, null);
  assert.equal(e.effective().lifetime, true);
  // a reinstall: empty entitlements, same device id
  const fresh = await makeEntitlements({ clock: b.clock });
  const again = createPromoClient({ baseUrl: 'http://localhost:8787', deviceId: () => DEVICE, entitlements: fresh.e, fetchImpl });
  assert.equal(await again.restore(), 2);
  assert.equal(fresh.e.effective().lifetime, true);
  // another device cannot reuse a restored token
  const stranger = await makeEntitlements({ deviceId: OTHER, clock: b.clock });
  assert.equal(await stranger.e.grantPromo((await b.call('/v1/promo/restore', { deviceId: DEVICE })).body.tokens[0]), null);
});

test('promo client: server says yes without a valid signature -> nothing is granted; network, rate limit, server error and not-configured are told apart', async () => {
  const { e } = await makeEntitlements();
  const mk = (fetchImpl, baseUrl = 'https://api.mydocs.test') => createPromoClient({ baseUrl, deviceId: () => DEVICE, entitlements: e, fetchImpl });
  const json = (status, body) => async () => new Response(JSON.stringify(body), { status });
  await assert.rejects(mk(json(200, { token: 'forged.token' })).redeem('MD15-AAAA-BBBB-CCCC'), (err) => err.code === 'SERVER');
  await assert.rejects(mk(json(200, { ok: true })).redeem('MD15-AAAA-BBBB-CCCC'), (err) => err.code === 'SERVER');
  assert.equal(e.isPro(), false);
  await assert.rejects(mk(async () => { throw new TypeError('offline'); }).redeem('MD15-AAAA-BBBB-CCCC'), (err) => err.code === 'NETWORK');
  await assert.rejects(mk(json(429, {})).redeem('MD15-AAAA-BBBB-CCCC'), (err) => err.code === 'RATE_LIMITED');
  await assert.rejects(mk(json(500, { error: 'SERVER_ERROR' })).redeem('MD15-AAAA-BBBB-CCCC'), (err) => err.code === 'SERVER');
  for (const code of ['ALREADY_REDEEMED', 'CODE_EXPIRED', 'DISABLED', 'LIMIT_REACHED', 'ENTITLEMENT_EXPIRED']) {
    await assert.rejects(mk(json(409, { error: code })).redeem('MD15-AAAA-BBBB-CCCC'), (err) => err.code === code);
  }
  await assert.rejects(mk(json(200, {}), 'https://mydocs-api.example.com').redeem('MD15-AAAA-BBBB-CCCC'), (err) => err.code === 'NOT_CONFIGURED');
  assert.equal(isBackendConfigured('https://mydocs-api.example.com'), false);
  assert.equal(isBackendConfigured('http://evil.test'), false);
  assert.equal(isBackendConfigured('https://api.mydocs.test'), true);
  assert.equal(isBackendConfigured('http://localhost:8787'), true);
});

/* ---------- Google Play ---------- */

const purchase = (over = {}) => ({ productId: 'mydocs_pro_lifetime', purchaseToken: 'tok-1234567890', state: 'purchased', acknowledged: false, signature: '', originalJson: '{}', ...over });

function fakePlugin({ purchases = [], buy = { status: 'purchased' }, queryFails = false, ackFails = false } = {}) {
  const plugin = {
    acked: [], bought: 0,
    getProduct: async () => ({ productId: 'mydocs_pro_lifetime', name: 'MyDocs Pro', description: 'd', formattedPrice: '₹499.00', priceAmountMicros: 499_000_000, currencyCode: 'INR' }),
    purchase: async () => { plugin.bought++; return { ...buy, purchases: buy.purchases ?? purchases }; },
    queryPurchases: async () => { if (queryFails) throw Object.assign(new Error('x'), { code: 'OFFLINE' }); return { purchases }; },
    acknowledge: async ({ purchaseToken }) => { if (ackFails) throw new Error('ack'); plugin.acked.push(purchaseToken); },
  };
  return plugin;
}
const makeBilling = async (plugin, { mode = 'client', fetchImpl, clock } = {}) => {
  const { e } = await makeEntitlements({ clock });
  const billing = createBilling({ plugin, productId: 'mydocs_pro_lifetime', entitlements: e, deviceId: () => DEVICE, config: { mode, backendUrl: 'https://api.mydocs.test', licenseKey: '' }, fetchImpl });
  return { e, billing };
};

test('billing: the price comes from Google Play; a purchased item unlocks Pro and is acknowledged AFTER verification', async () => {
  const p = purchase();
  const plugin = fakePlugin({ buy: { status: 'purchased', purchases: [p] } });
  const { e, billing } = await makeBilling(plugin);
  assert.equal((await billing.loadProduct()).price, '₹499.00');
  assert.equal(e.isPro(), false);
  assert.deepEqual(await billing.purchase(), { status: 'purchased' });
  assert.equal(e.isPro(), true);
  assert.deepEqual(plugin.acked, [p.purchaseToken]);
});

test('billing: pending never unlocks, cancelled never unlocks, a purchase of another product is ignored', async () => {
  const pend = await makeBilling(fakePlugin({ buy: { status: 'pending', purchases: [purchase({ state: 'pending' })] } }));
  assert.deepEqual(await pend.billing.purchase(), { status: 'pending' });
  assert.equal(pend.e.isPro(), false);
  const cancel = await makeBilling(fakePlugin({ buy: { status: 'cancelled' } }));
  assert.deepEqual(await cancel.billing.purchase(), { status: 'cancelled' });
  assert.equal(cancel.e.isPro(), false);
  const other = await makeBilling(fakePlugin({ buy: { status: 'purchased', purchases: [purchase({ productId: 'something_else' })] } }));
  await assert.rejects(other.billing.purchase(), (err) => err.code === 'VERIFY_FAILED');
  assert.equal(other.e.isPro(), false);
  const err = await makeBilling(fakePlugin({ buy: { status: 'error', code: 'UNAVAILABLE' } }));
  await assert.rejects(err.billing.purchase(), (x) => x instanceof BillingError);
  await assert.rejects(createBilling({ plugin: null, productId: 'p', entitlements: err.e, config: {}, deviceId: () => DEVICE }).purchase(), (x) => x.code === 'UNAVAILABLE');
});

test('billing: a purchase in the pending state is not acknowledged; when it completes later, restore / launch grants it', async () => {
  const list = [purchase({ state: 'pending' })];
  const plugin = fakePlugin({ purchases: list });
  const { e, billing } = await makeBilling(plugin);
  assert.deepEqual(await billing.restore(), { status: 'pending' });
  assert.equal(await billing.refresh(), 'pending');
  assert.equal(plugin.acked.length, 0);
  list[0] = purchase();
  assert.equal(await billing.refresh(), 'granted');
  assert.equal(e.isPro(), true);
  assert.equal(plugin.acked.length, 1);
});

test('billing: restore after reinstall; "already owned" at purchase time restores instead of charging; nothing owned -> none', async () => {
  const owned = fakePlugin({ purchases: [purchase({ acknowledged: true })], buy: { status: 'owned' } });
  const a = await makeBilling(owned);
  assert.deepEqual(await a.billing.restore(), { status: 'restored' });
  assert.equal(a.e.isPro(), true);
  assert.equal(owned.acked.length, 0); // already acknowledged: not again
  const b = await makeBilling(fakePlugin({ purchases: [purchase()], buy: { status: 'owned' } }));
  assert.deepEqual(await b.billing.purchase(), { status: 'purchased' });
  assert.equal(b.e.isPro(), true);
  const none = await makeBilling(fakePlugin());
  assert.deepEqual(await none.billing.restore(), { status: 'none' });
  assert.equal(none.e.isPro(), false);
});

test('billing: a refund (purchase gone from Play) removes the Play entitlement; going offline changes nothing', async () => {
  const list = [purchase({ acknowledged: true })];
  const plugin = fakePlugin({ purchases: list });
  const { e, billing } = await makeBilling(plugin);
  assert.equal(await billing.refresh(), 'granted');
  plugin.queryPurchases = async () => { throw Object.assign(new Error('x'), { code: 'OFFLINE' }); };
  assert.equal(await billing.refresh(), 'offline');
  assert.equal(e.isPro(), true); // cached verification stands
  plugin.queryPurchases = async () => ({ purchases: [] });
  assert.equal(await billing.refresh(), 'none');
  assert.equal(e.isPro(), false);
});

test('billing: acknowledge failing does not lose Pro (it is retried later); an unacknowledged purchase is retried at refresh', async () => {
  const plugin = fakePlugin({ purchases: [purchase()], ackFails: true });
  const { e, billing } = await makeBilling(plugin);
  assert.equal(await billing.refresh(), 'granted');
  assert.equal(e.isPro(), true);
  plugin.acknowledge = async ({ purchaseToken }) => { plugin.acked.push(purchaseToken); };
  await billing.refresh();
  assert.equal(plugin.acked.length, 1);
});

test('billing, server verification: the server token unlocks; a refusal or an unreachable server never unlocks and never acknowledges', async () => {
  const good = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.match(String(url), /\/v1\/play\/verify$/);
    assert.equal(body.purchaseToken, 'tok-1234567890');
    return new Response(JSON.stringify({ token: signToken({ v: 1, kind: 'play', type: 'lifetime', id: 'play:o1', deviceId: DEVICE, iat: T0, exp: T0 + 30 * DAY_MS }, PEM) }), { status: 200 });
  };
  const ok = fakePlugin({ purchases: [purchase()] });
  const a = await makeBilling(ok, { mode: 'server', fetchImpl: good, clock: { t: T0 } });
  assert.equal(await a.billing.refresh(), 'granted');
  assert.equal(a.e.isPro(), true);
  assert.equal(ok.acked.length, 1);
  const refused = fakePlugin({ purchases: [purchase()] });
  const b = await makeBilling(refused, { mode: 'server', fetchImpl: async () => new Response('{}', { status: 402 }) });
  assert.equal(await b.billing.refresh(), 'unverified');
  assert.equal(b.e.isPro(), false);
  assert.equal(refused.acked.length, 0);
  const down = fakePlugin({ purchases: [purchase()] });
  const c = await makeBilling(down, { mode: 'server', fetchImpl: async () => { throw new TypeError('offline'); } });
  await assert.rejects(c.billing.restore(), (x) => x.code === 'OFFLINE');
  assert.equal(c.e.isPro(), false);
  const forged = await makeBilling(fakePlugin({ purchases: [purchase()] }), { mode: 'server', fetchImpl: async () => new Response(JSON.stringify({ token: 'a.b' }), { status: 200 }) });
  assert.equal(await forged.billing.refresh(), 'unverified');
  assert.equal(forged.e.isPro(), false);
});

test('Play verifier (fake Google): purchased -> order id; pending / cancelled / unknown product / bad token -> errors', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serviceAccount = { client_email: 'svc@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  let state = { status: 200, purchaseState: 0 };
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes('oauth2.googleapis.com')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
    assert.equal(init.headers.Authorization, 'Bearer at');
    return new Response(JSON.stringify({ purchaseState: state.purchaseState, orderId: 'GPA.1' }), { status: state.status });
  };
  const verifier = createPlayVerifier({ packageName: 'com.alichade.mydocs', productIds: ['mydocs_pro_lifetime'], serviceAccount, fetchImpl, now: () => T0 });
  assert.deepEqual(await verifier.verify({ productId: 'mydocs_pro_lifetime', purchaseToken: 'x'.repeat(40) }), { orderId: 'GPA.1' });
  assert.ok(calls.some((u) => u.includes('/purchases/products/mydocs_pro_lifetime/tokens/')));
  state = { status: 200, purchaseState: 1 };
  await assert.rejects(verifier.verify({ productId: 'mydocs_pro_lifetime', purchaseToken: 'x'.repeat(40) }), (e) => e instanceof PlayError && e.code === 'NOT_PURCHASED');
  state = { status: 404 };
  await assert.rejects(verifier.verify({ productId: 'mydocs_pro_lifetime', purchaseToken: 'x'.repeat(40) }), (e) => e.code === 'INVALID_PURCHASE');
  state = { status: 500 };
  await assert.rejects(verifier.verify({ productId: 'mydocs_pro_lifetime', purchaseToken: 'x'.repeat(40) }), (e) => e.code === 'PLAY_UNAVAILABLE');
  await assert.rejects(verifier.verify({ productId: 'other', purchaseToken: 'x'.repeat(40) }), (e) => e.code === 'UNKNOWN_PRODUCT');
  await assert.rejects(verifier.verify({ productId: 'mydocs_pro_lifetime', purchaseToken: 'short' }), (e) => e.code === 'INVALID_PURCHASE');
});

test('API: /v1/play/verify returns a 30-day signed token only when Google confirms; without a verifier it says not configured', async () => {
  const store = openStore(':memory:');
  const play = { verify: async ({ purchaseToken }) => { if (purchaseToken === 'bad-token-0000') throw new PlayError('NOT_PURCHASED', 'no'); return { orderId: 'GPA.9' }; } };
  const api = createApi({ store, privateKeyPem: PEM, pepper: PEPPER, play, now: () => T0 });
  const ok = await api.handle({ method: 'POST', path: '/v1/play/verify', body: { deviceId: DEVICE, productId: 'mydocs_pro_lifetime', purchaseToken: 'good-token-0000' }, ip: '3.3.3.3' });
  const payload = verifySigned(ok.body.token, JWK);
  assert.deepEqual([payload.kind, payload.deviceId, payload.exp - payload.iat], ['play', DEVICE, 30 * DAY_MS]);
  const no = await api.handle({ method: 'POST', path: '/v1/play/verify', body: { deviceId: DEVICE, productId: 'mydocs_pro_lifetime', purchaseToken: 'bad-token-0000' }, ip: '3.3.3.3' });
  assert.deepEqual([no.status, no.body.error], [402, 'NOT_PURCHASED']);
  const off = createApi({ store, privateKeyPem: PEM, pepper: PEPPER, now: () => T0 });
  assert.equal((await off.handle({ method: 'POST', path: '/v1/play/verify', body: { deviceId: DEVICE, productId: 'x', purchaseToken: 'y'.repeat(20) } })).body.error, 'NOT_CONFIGURED');
});

/* ---------- admin CLI, secrets, configuration ---------- */

test('admin tool: init creates the key and pepper once, generate prints plain codes only to the output file, list shows no codes', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'mydocs-admin-'));
  try {
    const env = { ...process.env, MYDOCS_SECRETS: join(dir, 'secrets'), MYDOCS_DB: join(dir, 'data', 'db.sqlite') };
    const run = (...args) => spawnSync(process.execPath, ['--no-warnings', new URL('../backend/admin.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...args], { env, encoding: 'utf8' });
    const init = run('init');
    assert.equal(init.status, 0, init.stderr);
    const out = join(dir, 'codes.txt');
    const gen = run('generate', '--batch', 'b1', '--out', out);
    assert.equal(gen.status, 0, gen.stderr);
    const text = readFileSync(out, 'utf8');
    assert.equal((text.match(/MD(15|3M|LT)-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/g) ?? []).length, 15); // default plan: 5 + 5 + 5
    assert.doesNotMatch(gen.stdout + gen.stderr, /MD(15|3M|LT)-[A-Z2-9]{4}/); // never on the console
    const list = run('list');
    assert.doesNotMatch(list.stdout, /MD(15|3M|LT)-[A-Z2-9]{4}/);
    assert.match(list.stdout, /15d|3m|lifetime/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no secret, private key, service account, pepper or promo code is shipped in the app', () => {
  const files = ['www/js/entitlement-config.js', 'www/js/promo.js', 'www/js/billing.js', 'www/js/app.js', 'www/index.html', 'android/app/src/main/java/com/alichade/mydocs/PlayBillingPlugin.java'];
  for (const f of files) {
    const text = read(f);
    assert.doesNotMatch(text, /BEGIN (EC |RSA )?PRIVATE KEY|private_key|client_email|MD(15|3M|LT)-[A-Z2-9]{4}-[A-Z2-9]{4}/, f);
  }
  assert.doesNotMatch(read('www/js/entitlement-config.js'), /"d":/); // a private JWK would carry "d"
  assert.match(read('.gitignore'), /backend\/\.secrets\//);
  assert.match(read('.gitignore'), /backend\/data\//);
  const cfg = read('www/js/entitlement-config.js');
  assert.match(cfg, /PRO_PRODUCT_ID = 'mydocs_pro_lifetime'/);
  assert.equal(JSON.parse(/SIGNING_PUBLIC_KEY = (\{.*\});/.exec(cfg)[1]).kty, 'EC');
});

test('CSP: connect-src allows the configured backend host (the app could not reach it otherwise)', () => {
  const html = read('www/index.html');
  const host = new URL(/BACKEND_URL = '([^']+)'/.exec(read('www/js/entitlement-config.js'))[1]).origin;
  assert.ok(/connect-src[^"]*/.exec(html)[0].includes(host), `index.html connect-src must list ${host}`);
});

/* ---------- translations ---------- */

test('every Pro / promo / billing message has an English and a Hindi text, and service errors are translated', () => {
  const keys = Object.keys(en).filter((k) => /^(plan|up|pro)\./.test(k) || /^err\.(docLimit|pro|promo|bill)/.test(k) || k === 'set.sizeProOption');
  assert.ok(keys.length > 50);
  for (const k of keys) { assert.ok(hi[k], `missing Hindi: ${k}`); assert.notEqual(hi[k], en[k], `Hindi equals English: ${k}`); }
  const cases = [
    new EntitlementError('DOCUMENT_LIMIT', 'MyDocs Basic can save up to 5 documents. Delete a document or upgrade to Pro for unlimited documents.'),
    createAccessPolicyError('backup'), createAccessPolicyError('drive'), createAccessPolicyError('sizeOptions'),
    new PromoError('INVALID_CODE', 'This promo code is not valid.'), new PromoError('ALREADY_REDEEMED', 'This promo code has already been redeemed.'),
    new PromoError('NETWORK', 'Could not reach the server. Check your internet connection and try again.'),
    new BillingError('UNAVAILABLE', 'Google Play purchases are not available on this device or in this build.'),
    new BillingError('OFFLINE', 'Could not reach Google Play. Check your internet connection and try again.'),
  ];
  try {
    for (const err of cases) {
      setLanguage('en');
      const english = errorText(err);
      assert.ok(english);
      setLanguage('hi');
      const hindi = errorText(err);
      assert.ok(hindi && hindi !== english, `not translated: ${err.message}`);
    }
  } finally { setLanguage('en'); }
});

function createAccessPolicyError(feature) {
  try { createAccessPolicy(() => ({ plan: PLAN.BASIC })).requirePro(feature); } catch (e) { return e; }
  throw new Error('expected a Pro requirement');
}

test('app wiring: services get the access policy; Settings / Backup / size options / prompts are driven by it', () => {
  const app = read('www/js/app.js');
  assert.match(app, /createDocumentService\(\{[^}]*access \}\)/);
  assert.match(app, /createBackupService\(\{[\s\S]*?access,/);
  assert.match(app, /createDriveClient\(\{ authorize: backupFiles\.authorizeDrive, access \}\)/);
  assert.match(app, /createMockService\(\{ access \}\)/);
  assert.match(app, /setSizeCapMb\(access\.sizeCapMb\(\)\)/);
  assert.match(app, /err instanceof EntitlementError\) \{ showProPrompt/);
  assert.match(app, /access\.canUse\('backup'\)/);
  assert.match(app, /billing\.refresh\(\)/);
  const index = read('www/index.html');
  for (const id of ['upgrade-scroller', 'up-buy', 'up-restore', 'up-code', 'up-redeem', 'pro-dialog', 'pr-upgrade', 'pr-redeem', 'pr-close']) assert.match(index, new RegExp(`id="${id}"`));
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /com\.android\.vending\.BILLING/);
  assert.match(read('android/app/src/main/java/com/alichade/mydocs/MainActivity.java'), /registerPlugin\(PlayBillingPlugin\.class\)/);
});

test.after(() => cleanupTemp());
