// Signed entitlement tokens. The server (backend/) signs a small JSON payload with its private ECDSA P-256 key; the app
// only holds the PUBLIC key (entitlement-config.js), so a token can be checked offline but never forged on the device.
//
//   token   = base64url(JSON payload) + "." + base64url(signature)       (signature: ECDSA P-256 / SHA-256, IEEE P1363 r||s)
//   payload = { v:1, kind:'promo'|'play', type:'15d'|'3m'|'lifetime', id, deviceId, iat, exp|null }   (times in ms since epoch)

const enc = new TextEncoder();

export const base64url = {
  encode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(text) {
    const b64 = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

/** Imports the server's public key (a JWK) for verifying. Returns null when no usable key is configured. */
export async function importPublicKey(jwk, subtle = globalThis.crypto?.subtle) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y || !subtle) return null;
  try {
    return await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch { return null; }
}

/** Returns the payload when the token is well formed and genuinely signed by the server; otherwise null. */
export async function verifyToken(token, publicKey, subtle = globalThis.crypto?.subtle) {
  if (!publicKey || !subtle || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const signature = base64url.decode(parts[1]);
    if (signature.length !== 64) return null;
    const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, enc.encode(parts[0]));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64url.decode(parts[0])));
    if (payload?.v !== 1 || !['promo', 'play'].includes(payload.kind) || !['15d', '3m', 'lifetime'].includes(payload.type)) return null;
    if (typeof payload.deviceId !== 'string' || !Number.isFinite(payload.iat)) return null;
    if (!(payload.exp === null || Number.isFinite(payload.exp))) return null;
    return payload;
  } catch { return null; }
}
