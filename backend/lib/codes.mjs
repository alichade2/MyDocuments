// Promo code generation and hashing. Codes look like MD15-XXXX-XXXX-XXXX / MD3M-... / MDLT-... (12 random characters,
// about 59 bits of entropy). Only a keyed hash of a code is stored on the server; the plain codes exist only in the one-time
// administrator output. The prefix is cosmetic: what a code grants is read from its stored record, never from its text.
import { createHmac, randomInt } from 'node:crypto';

export const TYPES = { '15d': { prefix: 'MD15', label: '15 days' }, '3m': { prefix: 'MD3M', label: '3 months' }, lifetime: { prefix: 'MDLT', label: 'Lifetime' } };
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0 or 1: nothing to mistake when typing a code

export function generateCode(type) {
  if (!TYPES[type]) throw new Error(`Unknown promo type: ${type}`);
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${TYPES[type].prefix}-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/** What the user typed -> the canonical form (case, spaces and dashes do not matter). Returns null when it cannot be a code. */
export function normalizeCode(input) {
  const raw = String(input ?? '').toUpperCase().replace(/[\s-]+/g, '');
  const m = /^(MD15|MD3M|MDLT)([A-Z2-9]{12})$/.exec(raw);
  if (!m) return null;
  const rest = m[2];
  if ([...rest].some((c) => !ALPHABET.includes(c))) return null;
  return `${m[1]}-${rest.slice(0, 4)}-${rest.slice(4, 8)}-${rest.slice(8)}`;
}

/** HMAC-SHA256 with a server-side secret ("pepper"): a leaked database alone does not reveal or help guess codes. */
export const hashCode = (canonical, pepper) => createHmac('sha256', pepper).update(canonical).digest('hex');
