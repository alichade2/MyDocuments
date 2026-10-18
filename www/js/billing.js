// Google Play purchase handling for the one-time "MyDocs Pro" product (non-consumable).
// Rules that make it safe:
//   - a "purchase succeeded" callback alone never unlocks anything: the purchase must be in the PURCHASED state (pending and
//     cancelled never count), belong to our product, and be verified (by the server, or by the Play client + optional signature check)
//   - it is acknowledged only AFTER that verification
//   - Google Play is the source of truth: at launch, and for "Restore Purchases", the list of owned purchases is read again; a purchase
//     that is gone (refunded / revoked) removes the Play entitlement
//   - without network the previously verified entitlement keeps working for its grace period (see entitlements.js)
export class BillingError extends Error {
  constructor(code, message) { super(message); this.name = 'BillingError'; this.code = code; }
}
const MESSAGES = {
  UNAVAILABLE: 'Google Play purchases are not available on this device or in this build.',
  PRODUCT_NOT_FOUND: 'MyDocs Pro is not available for purchase right now. Please try again later.',
  OFFLINE: 'Could not reach Google Play. Check your internet connection and try again.',
  PURCHASE_FAILED: 'The purchase could not be completed. Please try again.',
  VERIFY_FAILED: 'Your purchase could not be verified yet. Pro unlocks as soon as it is confirmed; try Restore Purchases in a moment.',
  BUSY: 'A purchase is already in progress.',
};
export const BILLING_MESSAGES = MESSAGES;
const fail = (code) => new BillingError(code, MESSAGES[code] ?? MESSAGES.PURCHASE_FAILED);

/** Checks the Play signature of a purchase with the app's licensing public key (base64 SPKI, RSA / SHA-1, as Google signs it). */
export async function verifyPlaySignature(purchase, licenseKeyBase64, subtle = globalThis.crypto?.subtle) {
  if (!licenseKeyBase64) return true; // no key configured: this extra check is not available
  try {
    const key = await subtle.importKey('spki', Uint8Array.from(atob(licenseKeyBase64), (c) => c.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-1' }, false, ['verify']);
    return await subtle.verify('RSASSA-PKCS1-v1_5', key, Uint8Array.from(atob(purchase.signature), (c) => c.charCodeAt(0)), new TextEncoder().encode(purchase.originalJson));
  } catch { return false; }
}

/**
 * @param {object} o
 * @param {object} o.plugin  the native PlayBilling plugin (connect, getProduct, purchase, queryPurchases, acknowledge)
 * @param {string} o.productId
 * @param {object} o.entitlements  createEntitlements() instance
 * @param {{mode:'server'|'client', backendUrl:string, licenseKey:string}} o.config
 */
export function createBilling({ plugin, productId, entitlements, config, deviceId, fetchImpl = (...a) => globalThis.fetch(...a), isBackendConfigured = () => true }) {
  let product = null;

  const mapNative = (e) => {
    const code = String(e?.code ?? '');
    if (code in MESSAGES) return fail(code);
    return fail('PURCHASE_FAILED');
  };

  /** Asks the server to confirm the purchase with the Google Play Developer API; resolves a signed token. */
  async function verifyOnServer(purchase) {
    if (!isBackendConfigured(config.backendUrl)) throw fail('VERIFY_FAILED');
    let response;
    try {
      response = await fetchImpl(`${config.backendUrl.replace(/\/+$/, '')}/v1/play/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: deviceId(), productId, purchaseToken: purchase.purchaseToken }),
      });
    } catch { throw fail('OFFLINE'); }
    const data = await response.json().catch(() => null);
    if (!response.ok || typeof data?.token !== 'string') throw fail('VERIFY_FAILED');
    return data.token;
  }

  /**
   * Turns one purchase from Google Play into Pro (or not). Resolves 'granted' | 'pending' | 'ignored'. Throws BillingError when a
   * genuine purchase could not be verified (it is then NOT acknowledged and nothing is granted; the next refresh retries).
   */
  async function confirm(purchase) {
    if (purchase?.productId !== productId) return 'ignored';
    if (purchase.state === 'pending') return 'pending';
    if (purchase.state !== 'purchased') return 'ignored';
    if (!(await verifyPlaySignature(purchase, config.licenseKey))) throw fail('VERIFY_FAILED');
    if (config.mode === 'server') {
      const token = await verifyOnServer(purchase);
      if (!(await entitlements.grantPlayServer(token))) throw fail('VERIFY_FAILED');
    } else {
      entitlements.grantPlayClient();
    }
    if (!purchase.acknowledged) {
      try { await plugin.acknowledge({ purchaseToken: purchase.purchaseToken }); } catch { /* retried at the next refresh; Pro stays unlocked */ }
    }
    return 'granted';
  }

  return {
    /** The product as Google Play describes it (name, price in the user's currency). Throws BillingError. */
    async loadProduct() {
      if (!plugin) throw fail('UNAVAILABLE');
      try { product = await plugin.getProduct({ productId }); } catch (e) { throw mapNative(e); }
      return { id: product.productId, name: product.name, description: product.description, price: product.formattedPrice, priceMicros: product.priceAmountMicros, currency: product.currencyCode };
    },

    /** Starts the purchase. Resolves { status: 'purchased' | 'pending' | 'cancelled' } - 'purchased' only after verification. */
    async purchase() {
      if (!plugin) throw fail('UNAVAILABLE');
      let result;
      try { result = await plugin.purchase({ productId }); } catch (e) { throw mapNative(e); }
      if (result.status === 'cancelled') return { status: 'cancelled' };
      if (result.status === 'owned') return this.restore().then((r) => ({ status: r.status === 'restored' ? 'purchased' : 'pending' })); // already bought: restore it, no second charge
      if (result.status !== 'purchased' && result.status !== 'pending') throw fail(result.code === 'OFFLINE' ? 'OFFLINE' : 'PURCHASE_FAILED');
      let outcome = 'ignored';
      for (const p of result.purchases ?? []) { const o = await confirm(p); if (o === 'granted') outcome = 'granted'; else if (o === 'pending' && outcome !== 'granted') outcome = 'pending'; }
      if (outcome === 'granted') return { status: 'purchased' };
      if (outcome === 'pending') return { status: 'pending' };
      throw fail('VERIFY_FAILED');
    },

    /** Restore Purchases: reads what Google Play says this account owns and re-verifies it. Resolves { status: 'restored' | 'pending' | 'none' }. */
    async restore() {
      if (!plugin) throw fail('UNAVAILABLE');
      let list;
      try { list = (await plugin.queryPurchases()).purchases ?? []; } catch (e) { throw mapNative(e); }
      let pending = false;
      for (const p of list) {
        const outcome = await confirm(p);
        if (outcome === 'granted') return { status: 'restored' };
        if (outcome === 'pending' && p.productId === productId) pending = true;
      }
      return { status: pending ? 'pending' : 'none' };
    },

    /**
     * Quiet check at launch / return: grants, keeps or removes the Play entitlement according to what Google Play reports now.
     * A failure to reach Play changes nothing (the cached verification and its grace period stand).
     */
    async refresh() {
      if (!plugin) return 'unavailable';
      let list;
      try { list = (await plugin.queryPurchases()).purchases ?? []; } catch { return 'offline'; }
      const mine = list.filter((p) => p.productId === productId);
      for (const p of mine) {
        try { if ((await confirm(p)) === 'granted') return 'granted'; } catch { return 'unverified'; }
      }
      if (!mine.some((p) => p.state === 'pending')) { if (entitlements.hasPlay()) entitlements.revokePlay(); return 'none'; }
      return 'pending';
    },
    get product() { return product; },
  };
}
