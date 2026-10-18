// Promo-code and entitlement storage (SQLite via node:sqlite). Redemption runs in ONE `BEGIN IMMEDIATE` transaction, so two
// requests for the same single-use code can never both succeed, even when they arrive at the same moment.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DAY_MS = 86_400_000;

/** UTC calendar months (31 Jan + 3 months = 30 Apr). Mirrors www/js/entitlements.js. */
export function addCalendarMonths(ms, months) {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.getTime();
}

export function entitlementExpiry(type, redeemedAt) {
  if (type === '15d') return redeemedAt + 15 * DAY_MS;
  if (type === '3m') return addCalendarMonths(redeemedAt, 3);
  if (type === 'lifetime') return null;
  throw new Error(`Unknown entitlement type: ${type}`);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS promo_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('15d', '3m', 'lifetime')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    valid_until INTEGER,
    max_redemptions INTEGER NOT NULL DEFAULT 1 CHECK (max_redemptions >= 1),
    batch TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS redemptions (
    code_id TEXT NOT NULL REFERENCES promo_codes(id),
    device_id TEXT NOT NULL,
    redeemed_at INTEGER NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (code_id, device_id)
  );
  CREATE TABLE IF NOT EXISTS play_purchases (
    device_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    order_id TEXT,
    token_hash TEXT NOT NULL,
    verified_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, token_hash)
  );`;

export function openStore(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const payloadOf = (code, deviceId, redeemedAt, expiresAt) => ({ v: 1, kind: 'promo', type: code.type, id: code.id, deviceId, iat: redeemedAt, exp: expiresAt });

  return {
    db,
    addCode({ id, codeHash, type, validUntil = null, maxRedemptions = 1, batch = null, createdAt }) {
      db.prepare('INSERT INTO promo_codes (id, code_hash, type, valid_until, max_redemptions, batch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, codeHash, type, validUntil, maxRedemptions, batch, createdAt);
    },

    /**
     * Redeems a code for a device. Atomic. Returns { ok: true, payload } or { ok: false, error } where error is one of
     * INVALID_CODE, DISABLED, CODE_EXPIRED, ALREADY_REDEEMED, LIMIT_REACHED, ENTITLEMENT_EXPIRED.
     * The same device asking again gets the SAME entitlement back (no extension), which also restores it after a reinstall.
     */
    redeem({ codeHash, deviceId, now }) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const code = db.prepare('SELECT * FROM promo_codes WHERE code_hash = ?').get(codeHash);
        let result;
        if (!code) result = { ok: false, error: 'INVALID_CODE' };
        else if (code.status !== 'active') result = { ok: false, error: 'DISABLED' };
        else {
          const mine = db.prepare('SELECT * FROM redemptions WHERE code_id = ? AND device_id = ?').get(code.id, deviceId);
          if (mine) {
            result = mine.expires_at !== null && now >= mine.expires_at
              ? { ok: false, error: 'ENTITLEMENT_EXPIRED' }
              : { ok: true, payload: payloadOf(code, deviceId, mine.redeemed_at, mine.expires_at), repeat: true };
          } else if (code.valid_until !== null && now >= code.valid_until) {
            result = { ok: false, error: 'CODE_EXPIRED' };
          } else {
            const used = db.prepare('SELECT COUNT(*) AS n FROM redemptions WHERE code_id = ?').get(code.id).n;
            if (used >= code.max_redemptions) result = { ok: false, error: code.max_redemptions === 1 ? 'ALREADY_REDEEMED' : 'LIMIT_REACHED' };
            else {
              const expiresAt = entitlementExpiry(code.type, now);
              db.prepare('INSERT INTO redemptions (code_id, device_id, redeemed_at, expires_at) VALUES (?, ?, ?, ?)').run(code.id, deviceId, now, expiresAt);
              result = { ok: true, payload: payloadOf(code, deviceId, now, expiresAt), repeat: false };
            }
          }
        }
        db.exec('COMMIT');
        return result;
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* keep the original error */ }
        throw err;
      }
    },

    /** Promo entitlements this device redeemed that are still active (for restoring after a reinstall). */
    restore({ deviceId, now }) {
      return db.prepare(
        `SELECT c.*, r.redeemed_at, r.expires_at FROM redemptions r JOIN promo_codes c ON c.id = r.code_id
          WHERE r.device_id = ? AND c.status = 'active' AND (r.expires_at IS NULL OR r.expires_at > ?)`)
        .all(deviceId, now).map((row) => payloadOf(row, deviceId, row.redeemed_at, row.expires_at));
    },

    setStatus(id, status) {
      return db.prepare('UPDATE promo_codes SET status = ? WHERE id = ?').run(status, id).changes;
    },

    /** Never returns hashes or plain codes. */
    list() {
      return db.prepare(
        `SELECT c.id, c.type, c.status, c.valid_until AS validUntil, c.max_redemptions AS maxRedemptions, c.batch,
                (SELECT COUNT(*) FROM redemptions r WHERE r.code_id = c.id) AS redemptions
           FROM promo_codes c ORDER BY c.batch, c.type, c.id`).all();
    },

    recordPlay({ deviceId, productId, orderId, tokenHash, verifiedAt }) {
      db.prepare('INSERT INTO play_purchases (device_id, product_id, order_id, token_hash, verified_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(device_id, token_hash) DO UPDATE SET verified_at = excluded.verified_at')
        .run(deviceId, productId, orderId ?? null, tokenHash, verifiedAt);
    },
    close() { db.close(); },
  };
}
