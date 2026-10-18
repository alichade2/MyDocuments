// Signing of entitlement tokens (server side). Token format and payload: see www/js/entitlement-token.js.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

export const b64u = (buffer) => Buffer.from(buffer).toString('base64url');

export function generateSigningKey() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return privateKey.export({ type: 'pkcs8', format: 'pem' });
}

export const publicJwk = (privatePem) => {
  const jwk = createPublicKey(createPrivateKey(privatePem)).export({ format: 'jwk' });
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
};

/** payload -> "base64url(json).base64url(signature)" (ECDSA P-256, SHA-256, IEEE P1363 r||s as WebCrypto expects). */
export function signToken(payload, privatePem) {
  const body = b64u(JSON.stringify(payload));
  const signature = sign('sha256', Buffer.from(body), { key: createPrivateKey(privatePem), dsaEncoding: 'ieee-p1363' });
  return `${body}.${b64u(signature)}`;
}

/** Server-side check (used by tests and tools): returns the payload or null. */
export function verifySigned(token, publicKeyJwk) {
  const [body, signature] = String(token).split('.');
  if (!body || !signature) return null;
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', ...publicKeyJwk }, format: 'jwk' });
  const ok = verify('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
  return ok ? JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) : null;
}
