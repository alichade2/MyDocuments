// The effective entitlement (Basic or Pro) of this installation, built from verified sources:
//   1. a Google Play purchase (lifetime, non-consumable) - verified by the server (signed token) or, without a backend,
//      by the Play client (cached with a grace period, see PLAY_GRACE_DAYS)
//   2. promo entitlements (15 days / 3 months / lifetime) - ALWAYS a server-signed token that is checked here with the
//      server's public key, so the device cannot invent one by editing storage
// Nothing in storage is trusted on its own: a stored token only counts after its signature, device binding and expiry are checked.
//
// Rules: a Play purchase or a lifetime promo is permanent Pro; temporary promos give Pro until their expiry; the best valid
// source wins and one expiring never downgrades a user who still has another valid source. The clock cannot be turned
// back to extend a temporary promo (the latest time ever seen is remembered).
import { PLAN } from './access.js';
import { verifyToken } from './entitlement-token.js';

export const ENTITLEMENT_KEY = 'mydocs.entitlements';
export const DAY_MS = 86_400_000;

const BASIC = Object.freeze({ plan: PLAN.BASIC, source: 'none', type: null, lifetime: false, expiresAt: null });

/** Adds calendar months in UTC (31 Jan + 3 months = 30 Apr, never "31 Apr"). */
export function addCalendarMonths(ms, months) {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

/**
 * @param {object} o
 * @param {Storage} [o.storage]
 * @param {()=>number} [o.now]
 * @param {Promise<CryptoKey|null>|CryptoKey|null} o.publicKey  the server's signing key (verify only)
 * @param {()=>string} o.deviceId  stable id of this device (tokens are bound to it)
 */
export function createEntitlements({ storage = globalThis.localStorage, now = () => Date.now(), publicKey = null, deviceId, playGraceDays = 30, verify = verifyToken }) {
  let state = { lastSeen: 0, play: null, promos: [] }; // persisted form
  let play = null; // verified Play entitlement in memory: { mode, verifiedAt, payload? }
  let promos = []; // verified promo payloads in memory
  const promoTokens = new Map(); // promo id -> token (what is persisted)
  const listeners = new Set();
  let lastKey = '';

  const persist = () => { try { storage.setItem(ENTITLEMENT_KEY, JSON.stringify({ v: 1, ...state })); } catch { /* storage unavailable: the in-memory state still works for this run */ } };
  const clock = () => {
    const t = Math.max(now(), state.lastSeen);
    if (now() > state.lastSeen + 60_000) { state.lastSeen = now(); persist(); } // remember the latest time seen (clock-rollback guard)
    return t;
  };

  function effective() {
    const t = clock();
    if (play) {
      const grace = playGraceDays * DAY_MS;
      const valid = play.mode === 'server' ? (play.payload.exp === null || t < play.payload.exp) : t - play.verifiedAt <= grace;
      if (valid) return { plan: PLAN.PRO, source: 'play', type: 'lifetime', lifetime: true, expiresAt: null };
    }
    const live = promos.filter((p) => p.exp === null || t < p.exp);
    const forever = live.find((p) => p.exp === null);
    if (forever) return { plan: PLAN.PRO, source: 'promo', type: 'lifetime', lifetime: true, expiresAt: null };
    if (live.length) {
      const best = live.reduce((a, b) => (b.exp > a.exp ? b : a));
      return { plan: PLAN.PRO, source: 'promo', type: best.type, lifetime: false, expiresAt: best.exp };
    }
    return BASIC;
  }

  function emitIfChanged() {
    const e = effective();
    const key = `${e.plan}|${e.source}|${e.type}|${e.expiresAt}`;
    if (key === lastKey) return;
    lastKey = key;
    for (const fn of listeners) { try { fn(e); } catch { /* a listener must not break the others */ } }
  }

  async function readToken(token) {
    const key = await publicKey;
    const payload = await verify(token, key);
    if (!payload || payload.deviceId !== deviceId()) return null; // not signed by the server, or issued to another device
    return payload;
  }

  const api = {
    /** Loads what was stored and re-verifies it. Nothing stored is trusted without a valid signature. */
    async init() {
      try { state = { lastSeen: 0, play: null, promos: [], ...JSON.parse(storage.getItem(ENTITLEMENT_KEY) ?? '{}') }; } catch { state = { lastSeen: 0, play: null, promos: [] }; }
      if (!Number.isFinite(state.lastSeen)) state.lastSeen = 0;
      promos = [];
      promoTokens.clear();
      for (const token of Array.isArray(state.promos) ? state.promos : []) {
        const payload = await readToken(token);
        if (payload?.kind === 'promo') { promos = [...promos.filter((p) => p.id !== payload.id), payload]; promoTokens.set(payload.id, token); }
      }
      state.promos = [...promoTokens.values()];
      play = null;
      if (state.play?.mode === 'server') {
        const payload = await readToken(state.play.token);
        if (payload?.kind === 'play') play = { mode: 'server', verifiedAt: payload.iat, payload };
        else state.play = null;
      } else if (state.play?.mode === 'client' && Number.isFinite(state.play.verifiedAt)) {
        play = { mode: 'client', verifiedAt: Math.min(state.play.verifiedAt, now()) };
      } else state.play = null;
      persist();
      lastKey = '';
      emitIfChanged();
      return effective();
    },

    effective,
    isPro: () => effective().plan === PLAN.PRO,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Re-evaluates (for example after the app returns or a temporary entitlement may have expired) and notifies on a change. */
    tick: emitIfChanged,
    /** Milliseconds until the current temporary entitlement ends (null when none or permanent). */
    msUntilExpiry() {
      const e = effective();
      return e.expiresAt === null ? null : Math.max(0, e.expiresAt - clock());
    },

    /** Adds a promo entitlement from a server-signed token. Returns the verified payload or null (nothing changes). */
    async grantPromo(token) {
      const payload = await readToken(token);
      if (!payload || payload.kind !== 'promo') return null;
      if (payload.exp !== null && clock() >= payload.exp) return null; // already over
      promos = [...promos.filter((p) => p.id !== payload.id), payload]; // the same code again replaces its own entry, never adds time
      promoTokens.set(payload.id, token);
      state.promos = [...promoTokens.values()];
      persist();
      emitIfChanged();
      return payload;
    },

    /** The server confirmed the Play purchase and returned a signed token. */
    async grantPlayServer(token) {
      const payload = await readToken(token);
      if (!payload || payload.kind !== 'play') return null;
      play = { mode: 'server', verifiedAt: payload.iat, payload };
      state.play = { mode: 'server', token };
      persist();
      emitIfChanged();
      return payload;
    },

    /** Play's own purchase record was verified on the device (no backend): valid for `playGraceDays` after this moment. */
    grantPlayClient(verifiedAt = now()) {
      play = { mode: 'client', verifiedAt };
      state.play = { mode: 'client', verifiedAt };
      persist();
      emitIfChanged();
    },

    /** Play no longer reports the purchase (refunded / revoked) or it was never valid. */
    revokePlay() {
      play = null;
      state.play = null;
      persist();
      emitIfChanged();
    },
    hasPlay: () => play !== null,
  };
  return api;
}
