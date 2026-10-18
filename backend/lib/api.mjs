// The HTTP API as a plain function (request in, response out), so it can be tested without a network.
//   POST /v1/promo/redeem   { code, deviceId }                       -> { token, entitlement }  | { error }
//   POST /v1/promo/restore  { deviceId }                             -> { tokens: [ ... ] }
//   POST /v1/play/verify    { deviceId, productId, purchaseToken }   -> { token }               | { error }
//   GET  /v1/health
// There are NO administrative HTTP endpoints: codes are created, listed and disabled with `node backend/admin.mjs` on the server.
import { createHash } from 'node:crypto';
import { hashCode, normalizeCode } from './codes.mjs';
import { signToken } from './tokens.mjs';
import { DAY_MS } from './store.mjs';

const DEVICE_ID = /^[A-Za-z0-9_-]{16,128}$/;
const STATUS = {
  BAD_REQUEST: 400, INVALID_CODE: 404, DISABLED: 403, CODE_EXPIRED: 410, ENTITLEMENT_EXPIRED: 410, ALREADY_REDEEMED: 409, LIMIT_REACHED: 409,
  RATE_LIMITED: 429, NOT_CONFIGURED: 501, INVALID_PURCHASE: 402, NOT_PURCHASED: 402, UNKNOWN_PRODUCT: 400, PLAY_UNAVAILABLE: 503, PLAY_AUTH: 503, SERVER_ERROR: 500,
};
export const PLAY_TOKEN_DAYS = 30; // a Play token must be refreshed (the app does it at launch when online) within this time

/** A small in-memory limiter: too many failed attempts from one address or device are refused for a while. */
export function createLimiter({ max = 10, windowMs = 10 * 60_000, now = () => Date.now() } = {}) {
  const hits = new Map();
  const recent = (key) => { const t = now(); const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs); hits.set(key, list); return list; };
  return {
    blocked: (...keys) => keys.some((k) => recent(k).length >= max),
    fail: (...keys) => { for (const k of keys) recent(k).push(now()); },
  };
}

export function createApi({ store, privateKeyPem, pepper, play = null, now = () => Date.now(), limiter = createLimiter({ now }) }) {
  const fail = (error) => ({ status: STATUS[error] ?? 400, body: { error } });

  return {
    async handle({ method, path, body, ip = 'unknown' }) {
      try {
        if (method === 'GET' && path === '/v1/health') return { status: 200, body: { ok: true } };
        if (method !== 'POST' || !body || typeof body !== 'object') return fail('BAD_REQUEST');
        const deviceId = body.deviceId;
        if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) return fail('BAD_REQUEST');

        if (path === '/v1/promo/redeem') {
          if (limiter.blocked(`ip:${ip}`, `dev:${deviceId}`)) return fail('RATE_LIMITED');
          const canonical = normalizeCode(body.code);
          if (!canonical) { limiter.fail(`ip:${ip}`, `dev:${deviceId}`); return fail('INVALID_CODE'); }
          const result = store.redeem({ codeHash: hashCode(canonical, pepper), deviceId, now: now() });
          if (!result.ok) { limiter.fail(`ip:${ip}`, `dev:${deviceId}`); return fail(result.error); }
          return { status: 200, body: { token: signToken(result.payload, privateKeyPem), entitlement: { type: result.payload.type, expiresAt: result.payload.exp }, repeat: result.repeat } };
        }

        if (path === '/v1/promo/restore') {
          if (limiter.blocked(`ip:${ip}`)) return fail('RATE_LIMITED');
          return { status: 200, body: { tokens: store.restore({ deviceId, now: now() }).map((p) => signToken(p, privateKeyPem)) } };
        }

        if (path === '/v1/play/verify') {
          if (!play) return fail('NOT_CONFIGURED');
          if (limiter.blocked(`ip:${ip}`, `dev:${deviceId}`)) return fail('RATE_LIMITED');
          const { productId, purchaseToken } = body;
          try {
            const { orderId } = await play.verify({ productId, purchaseToken });
            const t = now();
            store.recordPlay({ deviceId, productId, orderId, tokenHash: createHash('sha256').update(purchaseToken).digest('hex'), verifiedAt: t });
            const payload = { v: 1, kind: 'play', type: 'lifetime', id: `play:${orderId ?? 'order'}`, deviceId, iat: t, exp: t + PLAY_TOKEN_DAYS * DAY_MS };
            return { status: 200, body: { token: signToken(payload, privateKeyPem) } };
          } catch (err) {
            if (err?.code && err.code in STATUS) { if (err.code !== 'PLAY_UNAVAILABLE' && err.code !== 'PLAY_AUTH') limiter.fail(`ip:${ip}`, `dev:${deviceId}`); return fail(err.code); }
            throw err;
          }
        }
        return fail('BAD_REQUEST');
      } catch {
        return fail('SERVER_ERROR'); // details are never sent to the client (or logged: codes and tokens are secrets)
      }
    },
  };
}
