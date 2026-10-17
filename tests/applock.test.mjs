// App Lock policy tests (Node). The real BiometricPrompt is Android-only; these cover the decision logic with a
// fake system prompt, plus static checks of the native files. Device behaviour is documented in PROJECT_STATUS.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createAppLock, nativeAuthenticator, previewAuthenticator, loadAppLockEnabled, saveAppLockEnabled,
  APP_LOCK_KEY, EXTERNAL_GRACE_MS, LOCK_MESSAGES, lockMessage,
} from '../www/js/applock.js';
import { buildSettingsSections } from '../www/js/menu.js';
import { ICON_PATHS } from '../www/js/icons.js';

const memStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, map: m };
};
const brokenStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };

/** Fake "system prompt": outcomes are queued; every call is recorded. */
function fakeAuth({ secure = true, available = true, results = [] } = {}) {
  const calls = [];
  const queue = [...results];
  const protect = [];
  return {
    calls, protect, queue,
    status: async () => ({ secure, available, biometric: true }),
    authenticate: async (o) => { calls.push(o); return queue.length ? queue.shift() : { ok: true }; },
    setProtectRecents: (v) => protect.push(v),
    openSecuritySettings: () => {},
  };
}
const OK = { ok: true };
const fail = (code) => ({ ok: false, code });

function make({ enabled = false, auth = fakeAuth(), storage = memStorage(enabled ? { [APP_LOCK_KEY]: '1' } : {}), now } = {}) {
  const changes = [];
  const lock = createAppLock({ authenticator: auth, storage, onChange: (l) => changes.push(l), now });
  return { lock, auth, storage, changes };
}

test('default is off: nothing is locked and the system prompt is never requested', async () => {
  const { lock, auth, changes } = make();
  assert.equal(lock.start(), false);
  assert.equal(lock.locked, false);
  lock.background();
  assert.equal(lock.locked, false);
  assert.deepEqual(await lock.foreground(), { ok: true });
  assert.equal(auth.calls.length, 0);
  assert.deepEqual(changes, []);
});

test('preference storage: broken storage reads as off and a failed write is reported', () => {
  assert.equal(loadAppLockEnabled(brokenStorage), false);
  assert.equal(saveAppLockEnabled(true, brokenStorage), false);
  const s = memStorage();
  assert.equal(saveAppLockEnabled(true, s), true);
  assert.equal(loadAppLockEnabled(s), true);
  assert.equal(saveAppLockEnabled(false, s), true);
  assert.equal(loadAppLockEnabled(s), false);
});

test('launch with App Lock on starts locked (also after a restart) until the system confirms authentication', async () => {
  const { lock, auth, changes } = make({ enabled: true });
  assert.equal(lock.start(), true);
  assert.equal(lock.locked, true, 'a saved "enabled" flag alone never unlocks');
  assert.deepEqual(auth.protect, [true]);
  assert.deepEqual(await lock.unlock(), { ok: true });
  assert.equal(lock.locked, false);
  assert.deepEqual(changes, [true, false]);
  assert.equal(auth.calls.length, 1);
});

test('authentication failure, cancellation, lockout and errors keep the app locked and allow a retry', async () => {
  const auth = fakeAuth({ results: [fail('CANCELED'), fail('LOCKOUT'), fail('NOT_AVAILABLE'), fail('ERROR'), OK] });
  const { lock } = make({ enabled: true, auth });
  lock.start();
  for (const code of ['CANCELED', 'LOCKOUT', 'NOT_AVAILABLE', 'ERROR']) {
    assert.deepEqual(await lock.unlock(), { ok: false, code });
    assert.equal(lock.locked, true, code);
  }
  assert.deepEqual(await lock.unlock(), { ok: true });
  assert.equal(lock.locked, false);
});

test('a thrown error from the prompt never unlocks', async () => {
  const auth = fakeAuth();
  auth.authenticate = async () => { throw new Error('boom'); };
  const { lock } = make({ enabled: true, auth });
  lock.start();
  assert.deepEqual(await lock.unlock(), { ok: false, code: 'ERROR' });
  assert.equal(lock.locked, true);
});

test('only one authentication prompt at a time', async () => {
  let release;
  const auth = fakeAuth();
  auth.authenticate = () => new Promise((r) => { release = () => r(OK); });
  const { lock } = make({ enabled: true, auth });
  lock.start();
  const first = lock.unlock();
  assert.equal(lock.prompting, true);
  assert.deepEqual(await lock.unlock(), { ok: false, code: 'BUSY' });
  assert.deepEqual(await lock.foreground(), { ok: false, code: 'BUSY' });
  release();
  assert.deepEqual(await first, { ok: true });
  assert.equal(lock.prompting, false);
  assert.equal(lock.locked, false);
});

test('leaving the app locks it; returning asks for authentication; navigation never does', async () => {
  const { lock, auth, changes } = make({ enabled: true });
  lock.start();
  await lock.unlock();
  assert.equal(auth.calls.length, 1);
  assert.deepEqual(await lock.foreground(), { ok: true }); // already unlocked: no extra prompt
  assert.equal(auth.calls.length, 1);
  lock.background();
  assert.equal(lock.locked, true);
  assert.deepEqual(await lock.foreground(), { ok: true });
  assert.equal(lock.locked, false);
  assert.equal(auth.calls.length, 2);
  assert.deepEqual(changes, [true, false, true, false]);
});

test('returning from the background with a cancelled prompt stays locked', async () => {
  const auth = fakeAuth({ results: [OK, fail('CANCELED')] });
  const { lock } = make({ enabled: true, auth });
  lock.start();
  await lock.unlock();
  lock.background();
  assert.deepEqual(await lock.foreground(), { ok: false, code: 'CANCELED' });
  assert.equal(lock.locked, true);
});

test('our own system screens (camera, picker, share sheet, viewer) do not lock the app', async () => {
  let t = 1000;
  const { lock } = make({ enabled: true, now: () => t });
  lock.start();
  await lock.unlock();
  // the app is paused while the external screen is open
  await lock.external(async () => { lock.background(); assert.equal(lock.locked, false); });
  // the share sheet call resolves immediately, the pause arrives right after it
  await lock.external(async () => {});
  t += 500;
  lock.background();
  assert.equal(lock.locked, false);
  await lock.foreground();
  // once the grace window has passed, leaving locks again
  t += EXTERNAL_GRACE_MS + 1;
  lock.background();
  assert.equal(lock.locked, true);
});

test('external() propagates the result and errors and always ends the suppression', async () => {
  const { lock } = make({ enabled: true });
  lock.start();
  await lock.unlock();
  assert.equal(await lock.external(async () => 42), 42);
  await assert.rejects(lock.external(async () => { throw new Error('x'); }), /x/);
  await lock.foreground();
  await new Promise((r) => setTimeout(r, 0));
  const t0 = Date.now();
  const l2 = createAppLock({ authenticator: fakeAuth(), storage: memStorage({ [APP_LOCK_KEY]: '1' }), now: () => t0 + 10 * EXTERNAL_GRACE_MS });
  l2.start(); await l2.unlock(); l2.background();
  assert.equal(l2.locked, true);
});

test('enabling: refuses without a secure screen lock and without an available authenticator; nothing is saved', async () => {
  let r = make({ auth: fakeAuth({ secure: false, available: false }) });
  assert.deepEqual(await r.lock.enable(), { ok: false, code: 'NO_SCREEN_LOCK' });
  assert.equal(r.storage.map.size, 0);
  assert.equal(r.lock.enabled, false);
  assert.equal(r.auth.calls.length, 0);
  r = make({ auth: fakeAuth({ secure: true, available: false }) });
  assert.deepEqual(await r.lock.enable(), { ok: false, code: 'NOT_AVAILABLE' });
  assert.equal(r.storage.map.size, 0);
});

test('enabling needs one successful authentication; cancel or failure leaves it off', async () => {
  for (const code of ['CANCELED', 'LOCKOUT', 'ERROR']) {
    const r = make({ auth: fakeAuth({ results: [fail(code)] }) });
    assert.deepEqual(await r.lock.enable(), { ok: false, code });
    assert.equal(r.lock.enabled, false);
    assert.equal(loadAppLockEnabled(r.storage), false);
  }
  const r = make();
  assert.deepEqual(await r.lock.enable(), { ok: true });
  assert.equal(r.lock.enabled, true);
  assert.equal(r.lock.locked, false, 'the session that just authenticated stays open');
  assert.equal(loadAppLockEnabled(r.storage), true);
  assert.deepEqual(r.auth.protect, [true]);
  // it is enforced on the next launch
  const next = make({ storage: r.storage });
  next.lock.start();
  assert.equal(next.lock.locked, true);
});

test('enabling reports a storage failure instead of pretending it is on', async () => {
  const r = make({ storage: brokenStorage });
  assert.deepEqual(await r.lock.enable(), { ok: false, code: 'SAVE_FAILED' });
  assert.equal(r.lock.enabled, false);
});

test('disabling requires authentication first and is saved only after it succeeds', async () => {
  const auth = fakeAuth({ results: [OK, fail('CANCELED'), fail('ERROR'), OK] });
  const r = make({ auth });
  await r.lock.enable();
  assert.deepEqual(await r.lock.disable(), { ok: false, code: 'CANCELED' });
  assert.equal(r.lock.enabled, true);
  assert.equal(loadAppLockEnabled(r.storage), true);
  assert.deepEqual(await r.lock.disable(), { ok: false, code: 'ERROR' });
  assert.equal(r.lock.enabled, true);
  assert.deepEqual(await r.lock.disable(), { ok: true });
  assert.equal(r.lock.enabled, false);
  assert.equal(loadAppLockEnabled(r.storage), false);
  assert.deepEqual(auth.protect, [true, false]);
  assert.equal(auth.calls.length, 4);
});

test('the setting cannot be turned off while the app is locked', async () => {
  const r = make({ enabled: true });
  r.lock.start();
  assert.deepEqual(await r.lock.disable(), { ok: false, code: 'CANCELED' });
  assert.equal(r.lock.enabled, true);
  assert.equal(r.auth.calls.length, 0);
});

test('disabling when already off needs no prompt; enabling when on needs none', async () => {
  const off = make();
  assert.deepEqual(await off.lock.disable(), { ok: true });
  assert.equal(off.auth.calls.length, 0);
  const on = make({ enabled: true });
  on.lock.start();
  await on.lock.unlock();
  assert.deepEqual(await on.lock.enable(), { ok: true });
  assert.equal(on.auth.calls.length, 1);
});

test('native adapter: success only when the plugin says success:true; every error code maps; unknown codes become ERROR', async () => {
  const res = (impl) => nativeAuthenticator({ authenticate: impl, status: async () => ({ secure: true, available: true }) });
  assert.deepEqual(await res(async () => ({ success: true })).authenticate(), { ok: true });
  assert.deepEqual(await res(async () => ({})).authenticate(), { ok: false, code: 'ERROR' });
  assert.deepEqual(await res(async () => ({ success: 'true' })).authenticate(), { ok: false, code: 'ERROR' });
  for (const code of ['CANCELED', 'LOCKOUT', 'NO_SCREEN_LOCK', 'NOT_AVAILABLE', 'BUSY', 'ERROR']) {
    assert.deepEqual(await res(async () => { throw Object.assign(new Error('x'), { code }); }).authenticate(), { ok: false, code });
  }
  for (const code of ['SAVE_FAILED', 'weird', undefined, '__proto__']) {
    assert.deepEqual(await res(async () => { throw Object.assign(new Error('x'), { code }); }).authenticate(), { ok: false, code: 'ERROR' });
  }
});

test('native adapter: a missing plugin or a failing status never grants access', async () => {
  const none = nativeAuthenticator(undefined);
  assert.deepEqual(await none.authenticate(), { ok: false, code: 'NOT_AVAILABLE' });
  assert.deepEqual(await none.status(), { secure: false, available: false, biometric: false });
  const broken = nativeAuthenticator({ status: async () => { throw new Error('x'); } });
  assert.equal((await broken.status()).available, false);
  const { lock } = make({ enabled: true, auth: none });
  lock.start();
  assert.deepEqual(await lock.unlock(), { ok: false, code: 'NOT_AVAILABLE' });
  assert.equal(lock.locked, true);
  assert.deepEqual(await make({ auth: none }).lock.enable(), { ok: false, code: 'NO_SCREEN_LOCK' });
});

test('browser-preview authenticator follows its test switch and defaults to success', async () => {
  const p = previewAuthenticator();
  delete globalThis.__mydocsPreviewAuth;
  assert.deepEqual(await p.authenticate(), { ok: true });
  globalThis.__mydocsPreviewAuth = 'cancel';
  assert.deepEqual(await p.authenticate(), { ok: false, code: 'CANCELED' });
  globalThis.__mydocsPreviewAuth = 'fail';
  assert.deepEqual(await p.authenticate(), { ok: false, code: 'ERROR' });
  globalThis.__mydocsPreviewAuth = 'nolock';
  assert.equal((await p.status()).secure, false);
  delete globalThis.__mydocsPreviewAuth;
});

test('every error code has a user-facing message and none mention credentials', () => {
  for (const code of ['CANCELED', 'LOCKOUT', 'NO_SCREEN_LOCK', 'NOT_AVAILABLE', 'BUSY', 'SAVE_FAILED', 'ERROR']) assert.ok(LOCK_MESSAGES[code], code);
  assert.equal(lockMessage('nope'), LOCK_MESSAGES.ERROR);
  assert.match(lockMessage('NO_SCREEN_LOCK'), /Android Settings/);
});

test('Settings has a Security section with the App Lock switch (off by default)', () => {
  const sec = buildSettingsSections().find((s) => s.id === 'security');
  assert.ok(sec);
  const row = sec.rows[0];
  assert.deepEqual([row.id, row.label, row.toggle, row.checked, row.action], ['app-lock', 'App Lock', true, false, 'app-lock']);
  assert.equal(row.description, "Protect your documents using your device's screen lock.");
  assert.ok(Object.hasOwn(ICON_PATHS, row.icon));
  assert.equal(buildSettingsSections({ appLock: true }).find((s) => s.id === 'security').rows[0].checked, true);
});

/* ---- static checks of the native side and of the page wiring ---- */
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('native plugin uses only the system BiometricPrompt: strong biometrics + device credential, no custom credential handling', () => {
  const java = read('android/app/src/main/java/com/alichade/mydocs/AppLockPlugin.java');
  assert.match(java, /BiometricPrompt\.PromptInfo\.Builder/);
  assert.match(java, /setAllowedAuthenticators\(BIOMETRIC_STRONG \| DEVICE_CREDENTIAL\)/);
  assert.match(java, /Build\.VERSION_CODES\.R/);
  assert.match(java, /setDeviceCredentialAllowed\(true\)/); // API 24-29 fallback
  assert.doesNotMatch(java, /setNegativeButtonText/); // a negative button is illegal together with device credentials
  assert.doesNotMatch(java, /BIOMETRIC_WEAK/);
  assert.doesNotMatch(java, /SharedPreferences|putString|getPin|Log\.[dievw]\(/);
  assert.match(java, /FLAG_SECURE/);
  assert.match(read('android/app/src/main/java/com/alichade/mydocs/MainActivity.java'), /registerPlugin\(AppLockPlugin\.class\)/);
});

test('manifest: biometric permission, a single exported launcher activity, no deep links or other entry intents', () => {
  const xml = read('android/app/src/main/AndroidManifest.xml');
  assert.match(xml, /USE_BIOMETRIC/);
  assert.equal((xml.match(/<intent-filter>/g) ?? []).length, 1);
  assert.match(xml, /android\.intent\.action\.MAIN/);
  assert.doesNotMatch(xml, /android\.intent\.action\.(VIEW|SEND)|<data /);
  assert.match(read('android/variables.gradle'), /minSdkVersion = 24/);
  assert.match(read('android/app/build.gradle'), /androidx\.biometric:biometric/);
});

test('page: the lock screen exists, the lock-init script runs before the stylesheet, and locked pages hide all other content', () => {
  const html = read('www/index.html');
  assert.ok(html.indexOf('js/lock-init.js') > 0 && html.indexOf('js/lock-init.js') < html.indexOf('css/styles.css'));
  assert.match(html, /id="lock-screen"/);
  assert.match(html, /id="lock-unlock"/);
  const css = read('www/css/styles.css');
  assert.match(css, /html\[data-locked\] body > :not\(\.lock-screen\) \{ visibility: hidden; \}/);
  assert.match(read('www/js/lock-init.js'), /mydocs\.appLock/);
  assert.equal(APP_LOCK_KEY, 'mydocs.appLock');
  const app = read('www/js/app.js');
  assert.match(app, /appStateChange/);
  assert.match(app, /capacitorAdapters\(undefined, \(fn\) => appLock\.external\(fn\)\)/);
});
