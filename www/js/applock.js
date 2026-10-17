// App Lock policy. MyDocs has NO password of its own: unlocking always goes through Android's system prompt
// (BiometricPrompt: strong biometrics or the device PIN/pattern/password). This module only decides WHEN to ask.
//
// - The saved "enabled" preference is only a switch for whether to ask. It is never proof of authentication.
// - Proof is the in-memory session state `locked`: it starts true on every launch (also after the process is
//   killed or the WebView reloads), becomes false only after the system confirms authentication, and goes back to
//   true when the app is left (see background()).

import { t } from './i18n.js';

export const APP_LOCK_KEY ='mydocs.appLock'; // also read by lock-init.js before first paint
/** After one of our own system screens (camera, file picker, share sheet, viewer) the app may leave/return without locking. */
export const EXTERNAL_GRACE_MS = 3000;

export const LOCK_MESSAGES = {
  CANCELED: 'Authentication was cancelled. MyDocs stays locked.',
  LOCKOUT: 'Too many attempts. Wait a moment, then try again.',
  NO_SCREEN_LOCK: 'No screen lock is set up on this device. Set a PIN, pattern or password in Android Settings, then come back.',
  NOT_AVAILABLE: 'Device authentication is not available right now. Please try again.',
  BUSY: 'An authentication prompt is already open.',
  SAVE_FAILED: 'Could not save the App Lock setting. Please try again.',
  ERROR: 'Authentication failed. Please try again.',
};

/** User-facing text for a result code, in the current language (LOCK_MESSAGES are the English defaults). */
export const lockMessage = (code) => t(`lockmsg.${Object.hasOwn(LOCK_MESSAGES, code) ? code : 'ERROR'}`);

export function loadAppLockEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem(APP_LOCK_KEY) === '1'; } catch { return false; }
}

/** Returns true when the preference was stored. */
export function saveAppLockEnabled(enabled, storage = globalThis.localStorage) {
  try { storage.setItem(APP_LOCK_KEY, enabled ? '1' : '0'); return storage.getItem(APP_LOCK_KEY) === (enabled ? '1' : '0'); } catch { return false; }
}

/**
 * Adapter for the native AppLock Capacitor plugin. Every failure maps to a code; there is no path that reports
 * success without the system saying so. A missing plugin means "not available" (stays locked), never "unlocked".
 */
export function nativeAuthenticator(plugin) {
  return {
    async status() {
      if (!plugin?.status) return { secure: false, available: false, biometric: false };
      try { return await plugin.status(); } catch { return { secure: false, available: false, biometric: false }; }
    },
    async authenticate(options = {}) {
      if (!plugin?.authenticate) return { ok: false, code: 'NOT_AVAILABLE' };
      try {
        const res = await plugin.authenticate(options);
        return res?.success === true ? { ok: true } : { ok: false, code: 'ERROR' };
      } catch (e) {
        const code = String(e?.code ?? '');
        return { ok: false, code: Object.hasOwn(LOCK_MESSAGES, code) && code !== 'SAVE_FAILED' ? code : 'ERROR' };
      }
    },
    setProtectRecents: (enabled) => plugin?.setProtectRecents?.({ enabled }).catch?.(() => {}),
    openSecuritySettings: () => plugin?.openSecuritySettings?.().catch?.(() => {}),
  };
}

/**
 * @param {object} deps
 * @param {{status():Promise<object>, authenticate(o):Promise<{ok:boolean, code?:string}>}} deps.authenticator
 * @param {Storage} [deps.storage]
 * @param {(locked:boolean)=>void} [deps.onChange] called whenever the locked state changes
 * @param {()=>number} [deps.now]
 */
export function createAppLock({ authenticator, storage = globalThis.localStorage, onChange = () => {}, now = () => Date.now() }) {
  const state = { enabled: false, locked: false, prompting: false, depth: 0, lastExternalEnd: -Infinity, expectedLeave: false };

  const setLocked = (locked) => {
    if (state.locked === locked) return;
    state.locked = locked;
    onChange(locked);
  };

  /** One prompt at a time: a second request while one is open is refused, never queued or approved. */
  async function prompt(options) {
    if (state.prompting) return { ok: false, code: 'BUSY' };
    state.prompting = true;
    try { return await authenticator.authenticate(options); } catch { return { ok: false, code: 'ERROR' }; } finally { state.prompting = false; }
  }

  const lock = {
    get enabled() { return state.enabled; },
    get locked() { return state.locked; },
    get prompting() { return state.prompting; },

    /** Reads the saved preference. A launch with App Lock on always starts locked. */
    start() {
      state.enabled = loadAppLockEnabled(storage);
      setLocked(state.enabled);
      authenticator.setProtectRecents?.(state.enabled);
      return state.enabled;
    },

    /** Asks Android to authenticate; unlocks only on a confirmed success. */
    async unlock() {
      if (!state.enabled || !state.locked) return { ok: true };
      const res = await prompt({ title: t('auth.unlockTitle'), subtitle: t('auth.unlockSubtitle') });
      if (res.ok) { state.expectedLeave = false; setLocked(false); return { ok: true }; }
      return { ok: false, code: res.code ?? 'ERROR' };
    },

    /** The app left the foreground. Locks immediately unless one of our own system screens is the reason. */
    background() {
      if (!state.enabled || state.locked) return;
      if (state.depth > 0 || now() - state.lastExternalEnd < EXTERNAL_GRACE_MS) { state.expectedLeave = true; return; }
      setLocked(true);
    },

    /** The app is visible again. Returns the unlock result when a prompt was needed. */
    async foreground() {
      state.expectedLeave = false;
      if (state.enabled && state.locked) return lock.unlock();
      return { ok: true };
    },

    /** Wrap calls that open Android screens of our own (camera, file picker, share sheet, document viewer). */
    async external(fn) {
      state.depth += 1;
      try { return await fn(); } finally { state.depth -= 1; state.lastExternalEnd = now(); }
    },

    /** Turning App Lock on needs a secure screen lock AND one successful authentication. */
    async enable() {
      if (state.enabled) return { ok: true };
      const st = await authenticator.status();
      if (!st?.secure) return { ok: false, code: 'NO_SCREEN_LOCK' };
      if (!st.available) return { ok: false, code: 'NOT_AVAILABLE' };
      const res = await prompt({ title: t('auth.enableTitle'), subtitle: t('auth.confirm') });
      if (!res.ok) return { ok: false, code: res.code ?? 'ERROR' };
      if (!saveAppLockEnabled(true, storage)) return { ok: false, code: 'SAVE_FAILED' };
      state.enabled = true;
      authenticator.setProtectRecents?.(true);
      setLocked(false); // this session just authenticated
      return { ok: true };
    },

    /** Turning App Lock off needs authentication first; the preference changes only after success. */
    async disable() {
      if (!state.enabled) return { ok: true };
      if (state.locked) return { ok: false, code: 'CANCELED' }; // the setting is unreachable while locked
      const res = await prompt({ title: t('auth.disableTitle'), subtitle: t('auth.confirm') });
      if (!res.ok) return { ok: false, code: res.code ?? 'ERROR' };
      if (!saveAppLockEnabled(false, storage)) return { ok: false, code: 'SAVE_FAILED' };
      state.enabled = false;
      authenticator.setProtectRecents?.(false);
      return { ok: true };
    },
  };
  return lock;
}

/**
 * Browser-preview stand-in for the system prompt (there is no BiometricPrompt in a browser). Behaviour can be
 * steered from tests with globalThis.__mydocsPreviewAuth = 'success' | 'cancel' | 'fail' | 'nolock'.
 */
export function previewAuthenticator() {
  const mode = () => globalThis.__mydocsPreviewAuth ?? 'success';
  return {
    async status() { return mode() === 'nolock' ? { secure: false, available: false, biometric: false } : { secure: true, available: true, biometric: true }; },
    async authenticate() {
      const m = mode();
      if (m === 'success') return { ok: true };
      return { ok: false, code: m === 'cancel' ? 'CANCELED' : m === 'nolock' ? 'NO_SCREEN_LOCK' : 'ERROR' };
    },
  };
}
