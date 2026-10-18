// Server-side verification of a Google Play in-app purchase with the Google Play Developer API.
// The service-account key is read from the server's environment (never shipped in the app). No dependencies: the OAuth JWT
// is signed with node:crypto. This module is tested with a fake Google; running it for real needs a service account that
// has been granted access to your app in Play Console (see backend/README.md).
import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const b64u = (v) => Buffer.from(v).toString('base64url');

export class PlayError extends Error {
  constructor(code, message) { super(message); this.name = 'PlayError'; this.code = code; }
}

export function createPlayVerifier({ packageName, productIds, serviceAccount, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  let cached = null; // { token, until }

  async function accessToken() {
    if (cached && cached.until > now() + 60_000) return cached.token;
    const iat = Math.floor(now() / 1000);
    const claim = { iss: serviceAccount.client_email, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 };
    const unsigned = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(JSON.stringify(claim))}`;
    const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(serviceAccount.private_key).toString('base64url')}`;
    const response = await fetchImpl(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    });
    if (!response.ok) throw new PlayError('PLAY_AUTH', 'Could not authorise with Google.');
    const body = await response.json();
    cached = { token: body.access_token, until: now() + (body.expires_in ?? 3600) * 1000 };
    return cached.token;
  }

  return {
    /** Resolves { orderId } for a genuinely purchased (not pending, cancelled or refunded) one-time product; throws PlayError otherwise. */
    async verify({ productId, purchaseToken }) {
      if (!productIds.includes(productId)) throw new PlayError('UNKNOWN_PRODUCT', 'Unknown product.');
      if (typeof purchaseToken !== 'string' || purchaseToken.length < 10 || purchaseToken.length > 4096) throw new PlayError('INVALID_PURCHASE', 'Invalid purchase token.');
      const url = `${API}/${encodeURIComponent(packageName)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
      const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
      if (response.status === 404 || response.status === 410) throw new PlayError('INVALID_PURCHASE', 'Purchase not found.');
      if (!response.ok) throw new PlayError('PLAY_UNAVAILABLE', 'Google Play could not be reached.');
      const purchase = await response.json();
      if (purchase.purchaseState !== 0) throw new PlayError('NOT_PURCHASED', 'The purchase is pending, cancelled or refunded.'); // 0 = purchased
      return { orderId: purchase.orderId ?? null };
    },
  };
}
