// Configuration of the Basic / Pro system. Nothing here is secret: the signing key below is the PUBLIC half (the private
// half lives only on your server, see backend/README.md). Replace the placeholders before a release.

/** Google Play in-app product (non-consumable, one-time). Create it in Play Console with exactly this ID, or change both. */
export const PRO_PRODUCT_ID = 'mydocs_pro_lifetime';

/**
 * Base URL of your entitlement server (https only; the host must also be listed in the Content-Security-Policy of
 * index.html under connect-src). While it is the placeholder below, promo codes and server verification are reported as
 * "not available" instead of pretending to work.
 */
export const BACKEND_URL = 'https://mydocs-api.example.com';

/**
 * How a Play purchase is verified.
 *   'server' - the app sends the purchase token to BACKEND_URL/v1/play/verify (Google Play Developer API on the server) and keeps the
 *              signed answer. Recommended for production.
 *   'client' - no backend: the Play Billing client state is used (and the purchase signature is checked when PLAY_LICENSE_KEY is
 *              set). A determined attacker with root access can fake this; see PROJECT_STATUS.md.
 */
export const PLAY_VERIFY_MODE = 'client';

/** Base64 RSA public key of your app (Play Console > Monetize > Monetization setup > Licensing). Optional; public, not a secret. */
export const PLAY_LICENSE_KEY = '';

/** Offline grace: a Play purchase checked only by the client counts as verified for this many days after the last successful check. */
export const PLAY_GRACE_DAYS = 30;

// BEGIN public-key
export const SIGNING_PUBLIC_KEY = {"kty":"EC","crv":"P-256","x":"TtlsBVpEAVWDgtRuClcjOzzzLK4-3hBnK0ExPaFaDb8","y":"GmKiwyd_DEhT-5KjxTlWeUtrgYP36lBZhigSVp5SOSE"};
// END public-key
