# MyDocs entitlement server (reference implementation)

A small, dependency-free Node.js (22.5+, uses `node:sqlite`) server for the two things that must NOT be decided on the phone:

1. **Promo codes**: validating and redeeming them atomically (single use, no extension, no reuse by another device).
2. **Google Play purchase verification** (optional, recommended): confirming a purchase token with the Google Play Developer API.

The app only ever holds the **public** half of a signing key. The server answers with short **signed tokens**; the app checks the signature
offline, so a fake "success" can never be produced by editing the app or its storage (see `www/js/entitlement-token.js`).

> Status: implemented and unit-tested (`tests/pro.test.mjs`, against fakes). It has **not** been deployed or exercised against the real
> Google Play Developer API. Until you deploy it and put its HTTPS address in `www/js/entitlement-config.js` (`BACKEND_URL`), the app reports
> promo codes as "not available in this build yet" rather than pretending to work.

## One-time setup

```bash
node backend/admin.mjs init            # creates backend/.secrets/signing-key.pem + pepper.txt (SECRET: back up, never commit)
node backend/admin.mjs sync-app-key    # writes the PUBLIC key into www/js/entitlement-config.js
node backend/admin.mjs generate --batch launch-2026-10 --out backend/.secrets/promo-codes-launch-2026-10.txt
```

`generate` defaults to **5 codes of each type (15 days, 3 months, lifetime) = 15 codes**. The plain codes are written **once** to the output file
(owner-only permissions) and never printed or stored; the database keeps only `HMAC-SHA256(pepper, code)`. Losing `pepper.txt` makes every stored
code unusable; losing `signing-key.pem` means issuing a new key and shipping an app update.

Other commands: `node backend/admin.mjs list` (no codes shown), `disable <id>`, `enable <id>`,
`generate --plan 15d:2,lifetime:1 --valid-days 180 --batch name`.

Code formats: `MD15-XXXX-XXXX-XXXX` (15 days), `MD3M-…` (3 calendar months), `MDLT-…` (lifetime); 12 random characters from a 31-letter alphabet
without lookalikes (about 59 bits), drawn with `crypto.randomInt`. What a code grants is read from its database record, never from its text.
Codes are single-use by default and valid for 365 days after creation (`--valid-days`).

## Run

```bash
PORT=8787 MYDOCS_ALLOWED_ORIGIN=https://localhost node backend/server.mjs
```

| Variable | Meaning | Default |
|---|---|---|
| `MYDOCS_DB` | SQLite file | `backend/data/mydocs.sqlite` |
| `MYDOCS_SECRETS` | folder with `signing-key.pem`, `pepper.txt` | `backend/.secrets` |
| `MYDOCS_ALLOWED_ORIGIN` | CORS origin of the app's WebView (Capacitor Android: `https://localhost`) | `https://localhost` |
| `PORT` | listen port | `8787` |
| `GOOGLE_SERVICE_ACCOUNT_FILE`, `PLAY_PACKAGE_NAME`, `PLAY_PRODUCT_IDS` | enable Play verification (see below) | off |

Deploy behind HTTPS (any reverse proxy / PaaS); the app refuses non-HTTPS backends (except loopback addresses for development). Keep the
SQLite file on persistent storage and back it up. The in-memory rate limiter is per process: run one instance, or move it to a shared store.

## API contract

All bodies are JSON, all endpoints are `POST` except health. `deviceId` is 16-128 characters of `[A-Za-z0-9_-]` (the app sends a 32-hex id).

| Endpoint | Request | Success (200) | Errors |
|---|---|---|---|
| `GET /v1/health` | - | `{ ok: true }` | - |
| `POST /v1/promo/redeem` | `{ code, deviceId }` | `{ token, entitlement: { type, expiresAt }, repeat }` | 400 `BAD_REQUEST`, 404 `INVALID_CODE`, 403 `DISABLED`, 410 `CODE_EXPIRED` / `ENTITLEMENT_EXPIRED`, 409 `ALREADY_REDEEMED` / `LIMIT_REACHED`, 429 `RATE_LIMITED` |
| `POST /v1/promo/restore` | `{ deviceId }` | `{ tokens: [token, ...] }` (this device's still-active promo entitlements) | 400, 429 |
| `POST /v1/play/verify` | `{ deviceId, productId, purchaseToken }` | `{ token }` (30-day signed Play token) | 402 `INVALID_PURCHASE` / `NOT_PURCHASED`, 400 `UNKNOWN_PRODUCT`, 501 `NOT_CONFIGURED`, 503 `PLAY_UNAVAILABLE`, 429 |

There are **no HTTP endpoints to create, list or disable codes**: administration is the CLI only, on a machine that has the secrets.

**Token** = `base64url(JSON payload) + "." + base64url(signature)`, ECDSA P-256 / SHA-256 (IEEE P1363 `r||s`).
Payload: `{ v: 1, kind: "promo" | "play", type: "15d" | "3m" | "lifetime", id, deviceId, iat, exp | null }` (ms since epoch; `exp: null` = permanent).
The app accepts a token only if the signature verifies with the embedded public key **and** `deviceId` is this device.

## Data model (SQLite)

* `promo_codes(id, code_hash UNIQUE, type, status 'active'|'disabled', valid_until, max_redemptions DEFAULT 1, batch, created_at)`
* `redemptions(code_id, device_id, redeemed_at, expires_at)`, primary key `(code_id, device_id)`
* `play_purchases(device_id, product_id, order_id, token_hash, verified_at)`

Redemption runs in one `BEGIN IMMEDIATE` transaction: concurrent attempts on one code produce exactly one winner (tested with 20 simultaneous
devices). The same device presenting the same code again receives the **same** entitlement (no extension, no new row), which is also how a
reinstall recovers it. A different device gets `ALREADY_REDEEMED`.

Expiry: 15 days = 15 x 24 h; 3 months = **calendar** months from the redemption instant (31 Oct -> 31 Jan; 30 Nov -> 28/29 Feb, end-of-month clamped);
lifetime = never. The server computes it once at redemption and signs it, so the app and server never disagree.

## Google Play verification

1. Play Console -> Setup -> API access: link a Google Cloud project, create a **service account**, grant it *View financial data* / *Manage orders*
   for your app. Download its JSON key and keep it **only on the server**.
2. `GOOGLE_SERVICE_ACCOUNT_FILE=/secure/key.json PLAY_PACKAGE_NAME=com.alichade.mydocs PLAY_PRODUCT_IDS=mydocs_pro_lifetime node backend/server.mjs`
3. In `www/js/entitlement-config.js` set `PLAY_VERIFY_MODE = 'server'` (and your real `BACKEND_URL`).

`play.mjs` calls `purchases.products.get` and accepts only `purchaseState === 0` (purchased; pending / cancelled are refused). With
`PLAY_VERIFY_MODE = 'client'` (the default, no server) the app trusts the Play Billing client's `PURCHASED` state plus, if you set
`PLAY_LICENSE_KEY`, the purchase signature; this is weaker: a rooted device can fake it. Use server mode for production.

## Limitations (be honest with yourself about these)

* No user accounts: identity is a per-install device id (native: SHA-256 of `ANDROID_ID` + package, which survives uninstall/reinstall on the
  same device and signing key; otherwise a random id kept in app storage). A factory reset or a different device is a different identity, so a
  promo code cannot follow a person to a new phone (a lifetime Play purchase does: use Restore Purchases).
* A Play purchase made through client-only verification cannot be proven to a server; refunds are noticed when the app next queries Play.
* Promo expiry on the device uses the device clock guarded by a "latest time seen" mark, so winding the clock back cannot revive an ended promo,
  but a device that is offline for months cannot be told a promo was disabled by an admin until it next restores.
* Rate limiting is in-memory and per process.
