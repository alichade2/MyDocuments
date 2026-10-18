// Basic / Pro access: the ONE place that knows what each plan may do. Screens ask this module; the services (documents,
// backup, Drive) call it at their persistence boundaries, so hiding a button is never the only protection.
//
//   Basic: up to 5 saved documents in total, 3 MB per document, no Backup & Restore / Drive backup, no larger size options.
//   Pro:   unlimited documents (practical storage limits), 3-15 MB size options, Backup & Restore, Drive backup.
//
// "Documents" are the user's real saved documents; the built-in sample entries (is_demo) are not counted.

export const PLAN = { BASIC: 'basic', PRO: 'pro' };
export const BASIC_LIMITS = { maxDocuments: 5, maxSizeMb: 3 };

/** Features that need Pro. Add an id here to gate a new premium feature everywhere with one line. */
export const PRO_FEATURES = {
  backup: 'Backup & Restore',
  drive: 'Google Drive backup',
  sizeOptions: 'Larger document sizes',
};

export class EntitlementError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'EntitlementError'; this.code = code; Object.assign(this, details); }
}

const MESSAGES = {
  backup: 'Backup & Restore is a MyDocs Pro feature. Upgrade to Pro to use it.',
  drive: 'Google Drive backup is a MyDocs Pro feature. Upgrade to Pro to use it.',
  sizeOptions: 'Document sizes above 3 MB are a MyDocs Pro feature. Upgrade to Pro to use them.',
  generic: 'This feature needs MyDocs Pro. Upgrade to Pro to use it.',
};
export const documentLimitMessage = (limit = BASIC_LIMITS.maxDocuments) => `MyDocs Basic can save up to ${limit} documents. Delete a document or upgrade to Pro for unlimited documents.`;

/**
 * @param {()=>{plan:string}} getEntitlement  current effective entitlement (see entitlements.js)
 */
export function createAccessPolicy(getEntitlement) {
  const isPro = () => getEntitlement().plan === PLAN.PRO;
  return {
    plan: () => (isPro() ? PLAN.PRO : PLAN.BASIC),
    isPro,
    /** Largest number of saved documents (Infinity for Pro). */
    maxDocuments: () => (isPro() ? Infinity : BASIC_LIMITS.maxDocuments),
    /** The most MB a single document may be, whatever the saved size setting says (null = no cap). */
    sizeCapMb: () => (isPro() ? null : BASIC_LIMITS.maxSizeMb),
    isSizeAllowed(mb) { const cap = isPro() ? null : BASIC_LIMITS.maxSizeMb; return cap === null || mb <= cap; },
    /** Can one more document be saved when `count` real documents exist? */
    canCreateDocument(count) { return isPro() || count < BASIC_LIMITS.maxDocuments; },
    assertCanCreateDocument(count) {
      if (!this.canCreateDocument(count)) throw new EntitlementError('DOCUMENT_LIMIT', documentLimitMessage(), { limit: BASIC_LIMITS.maxDocuments });
    },
    canUse: (feature) => isPro() || !(feature in PRO_FEATURES),
    /** Throws EntitlementError('PRO_REQUIRED') unless Pro is active. Called at the start of every Pro-only operation. */
    requirePro(feature = 'generic') {
      if (!isPro() && (feature === 'generic' || feature in PRO_FEATURES)) throw new EntitlementError('PRO_REQUIRED', MESSAGES[feature] ?? MESSAGES.generic, { feature });
    },
  };
}

/** For code that has no plan to apply (tests, tools): everything allowed. The app always passes the real policy. */
export const UNRESTRICTED_ACCESS = createAccessPolicy(() => ({ plan: PLAN.PRO }));
