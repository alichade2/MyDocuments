// Promo-code redemption. The app never decides whether a code is good: it sends the code to the entitlement server, and
// Pro is granted only when the server answers with a token that carries the server's signature (checked in entitlements.js).
// A code is never stored on the device and never logged.

export class PromoError extends Error {
  constructor(code, message) { super(message); this.name = 'PromoError'; this.code = code; }
}

const MESSAGES = {
  EMPTY: 'Please enter a promo code.',
  INVALID_CODE: 'This promo code is not valid.',
  ALREADY_REDEEMED: 'This promo code has already been redeemed.',
  CODE_EXPIRED: 'This promo code has expired.',
  DISABLED: 'This promo code is no longer active.',
  LIMIT_REACHED: 'This promo code has reached its redemption limit.',
  ENTITLEMENT_EXPIRED: 'The Pro access from this promo code has already ended.',
  RATE_LIMITED: 'Too many attempts. Please wait a few minutes and try again.',
  NETWORK: 'Could not reach the server. Check your internet connection and try again.',
  NOT_CONFIGURED: 'Promo codes are not available in this build yet.',
  SERVER: 'The promo code could not be checked right now. Please try again later.',
};
export const PROMO_MESSAGES = MESSAGES;
const fail = (code) => new PromoError(code, MESSAGES[code] ?? MESSAGES.SERVER);

/** The placeholder host of entitlement-config.js (or an empty URL) means "no server yet". */
export function isBackendConfigured(url) {
  try {
    const u = new URL(url);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return false;
    return !/(^|\.)example\.(com|org|net)$/i.test(u.hostname);
  } catch { return false; }
}

/**
 * @param {object} o
 * @param {string} o.baseUrl
 * @param {()=>string} o.deviceId
 * @param {{grantPromo(token:string):Promise<object|null>}} o.entitlements
 */
export function createPromoClient({ baseUrl, deviceId, entitlements, fetchImpl = (...a) => globalThis.fetch(...a) }) {
  async function post(path, body) {
    if (!isBackendConfigured(baseUrl)) throw fail('NOT_CONFIGURED');
    let response;
    try {
      response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch { throw fail('NETWORK'); }
    let data = null;
    try { data = await response.json(); } catch { /* not JSON */ }
    if (!response.ok) throw fail(typeof data?.error === 'string' && data.error in MESSAGES ? data.error : response.status === 429 ? 'RATE_LIMITED' : 'SERVER');
    if (!data) throw fail('SERVER');
    return data;
  }

  return {
    /**
     * Redeems a code. Resolves { type, expiresAt } (expiresAt null = lifetime) once the server confirmed it AND its signed token
     * verified on this device; rejects with a PromoError otherwise and grants nothing.
     */
    async redeem(input) {
      const code = String(input ?? '').trim();
      if (!code) throw fail('EMPTY');
      if (code.length > 64) throw fail('INVALID_CODE');
      const data = await post('/v1/promo/redeem', { code, deviceId: deviceId() });
      const payload = typeof data.token === 'string' ? await entitlements.grantPromo(data.token) : null;
      if (!payload) throw fail('SERVER'); // an answer without a valid signature is never trusted
      return { type: payload.type, expiresAt: payload.exp, repeat: Boolean(data.repeat) };
    },

    /** After a reinstall: asks the server for the promo entitlements this device already redeemed. Resolves how many were restored. */
    async restore() {
      const data = await post('/v1/promo/restore', { deviceId: deviceId() });
      let restored = 0;
      for (const token of Array.isArray(data.tokens) ? data.tokens : []) if (await entitlements.grantPromo(token)) restored++;
      return restored;
    },
  };
}
