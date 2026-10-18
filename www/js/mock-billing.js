// Browser-preview stand-in for the native PlayBilling plugin. It never grants anything by itself: a purchase only "succeeds" when a
// tester asks for it with globalThis.__mydocsPreviewBilling = { purchase: 'purchased' | 'pending' | 'cancelled', owned: true }.
// Without that the purchase reports that Google Play is unavailable, exactly like a device without a Play listing.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const knob = () => globalThis.__mydocsPreviewBilling ?? {};
const PRODUCT = 'mydocs_pro_lifetime';

export function createMockPlayBilling() {
  let owned = null;
  const purchaseOf = (state) => ({ productId: PRODUCT, purchaseToken: 'preview-token', state, acknowledged: false, signature: '', originalJson: '{}' });
  return {
    async deviceId() { return { deviceId: null }; },
    async getProduct({ productId }) {
      await wait(250);
      if (knob().productMissing) { const e = new Error('missing'); e.code = 'PRODUCT_NOT_FOUND'; throw e; }
      return { productId, name: 'MyDocs Pro (preview)', description: 'Preview product', formattedPrice: knob().price ?? '₹499.00', priceAmountMicros: 499_000_000, currencyCode: 'INR' };
    },
    async purchase() {
      await wait(400);
      const outcome = knob().purchase;
      if (outcome === 'cancelled') return { status: 'cancelled', purchases: [] };
      if (outcome === 'pending') return { status: 'pending', purchases: [purchaseOf('pending')] };
      if (outcome === 'purchased') { owned = purchaseOf('purchased'); return { status: 'purchased', purchases: [owned] }; }
      const e = new Error('unavailable'); e.code = 'UNAVAILABLE'; throw e;
    },
    async queryPurchases() { await wait(200); return { purchases: owned ? [owned] : [] }; },
    async acknowledge() { if (owned) owned.acknowledged = true; },
  };
}
