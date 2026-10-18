// Centralised localisation (English + Hindi). Everything the app itself says goes through t(); data never does:
// document names, file names and user-created category names are shown exactly as stored. The database keeps the
// English names of built-in categories (stable slugs are the keys); only their display label is localised here.
import en from './locales/en.js';
import hi from './locales/hi.js';

export const LANGUAGE_KEY = 'mydocs.language'; // also read by lang-init.js before first paint
export const DEFAULT_LANGUAGE = 'en';
export const LANGUAGES = [
  { id: 'en', nameKey: 'lang.name.en', subKey: 'lang.sub.en' },
  { id: 'hi', nameKey: 'lang.name.hi', subKey: 'lang.sub.hi' },
];

const DICTIONARIES = { en, hi };
let current = DEFAULT_LANGUAGE;

export const normalizeLanguage = (value) => (value === 'hi' ? 'hi' : DEFAULT_LANGUAGE);

export function loadLanguage(storage = globalThis.localStorage) {
  try { return normalizeLanguage(storage?.getItem(LANGUAGE_KEY)); } catch { return DEFAULT_LANGUAGE; }
}

/** Returns true when the preference was stored. */
export function saveLanguage(language, storage = globalThis.localStorage) {
  try { storage.setItem(LANGUAGE_KEY, normalizeLanguage(language)); return true; } catch { return false; }
}

export const getLanguage = () => current;

/** Switches the active language (no storage, no DOM): used by tests and by the app. */
export function setLanguage(language) {
  current = normalizeLanguage(language);
  return current;
}

const fill = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : text);

/** Translates a key; falls back to English, then to the key itself, so a missing string is visible but never breaks the UI. */
export function t(key, params) {
  return fill(DICTIONARIES[current][key] ?? en[key] ?? key, params);
}

export const hasKey = (key) => Object.hasOwn(en, key);

/** Plural-aware lookup: `<base>.one` for 1, `<base>.other` otherwise ({n} is filled in). */
export const tn = (base, n, params = {}) => t(`${base}.${n === 1 ? 'one' : 'other'}`, { n, ...params });

export const countLabel = (n) => tn('docs', n);

/**
 * Display name of a category. Built-in categories (identified by their stable slug) use the localised label; user
 * categories - and anything unknown - keep their stored name exactly.
 */
export function categoryLabel(category) {
  const slug = category?.slug ?? category?.categorySlug;
  if (slug && !String(slug).startsWith('custom-') && hasKey(`category.${slug}`)) return t(`category.${slug}`);
  return category?.name ?? category?.categoryName ?? '';
}

/**
 * Service messages are English strings with a stable shape. These patterns map them to translation keys (plus the
 * values to put back into the sentence). Anything not listed is shown as it is.
 */
const docsParam = (n) => ({ docs: countLabel(Number(n)) });
export const ERROR_PATTERNS = [
  [/^Please enter a category name\.$/, 'err.categoryNameEmpty'],
  [/^Category name must be (\d+) characters or fewer\.$/, 'err.categoryNameLong', (m) => ({ max: m[1] })],
  [/^Document name cannot be empty\.$/, 'err.nameEmpty'],
  [/^Name must be (\d+) characters or fewer\.$/, 'err.nameLong', (m) => ({ max: m[1] })],
  [/^Unknown category\.$/, 'err.unknownCategory'],
  [/^Document not found\.$/, 'err.notFound'],
  [/^Please choose one of the available icons\.$/, 'err.invalidIcon'],
  [/^A category with this name already exists\.$/, 'err.duplicateCategory'],
  [/^Built-in categories cannot be changed\.$/, 'err.lockedEdit'],
  [/^Built-in categories cannot be deleted\.$/, 'err.lockedDelete'],
  [/^This category still contains (\d+) documents?\. Choose where to move them first\.$/, 'err.categoryNotEmpty', (m) => docsParam(m[1])],
  [/^Choose a different category to move the documents to\.$/, 'err.moveDifferent'],
  [/^Unsupported file type "\.(.*)"\.$/, 'err.unsupportedType', (m) => ({ ext: m[1] })],
  [/^The selected file has no content\.$/, 'err.emptyFile'],
  [/^File size \((.+)\) exceeds the (\d+) MB limit\. Please select a smaller file or compress the document and try again\.$/, 'err.sizeFile', (m) => ({ size: m[1], limit: `${m[2]} MB` })],
  [/^Captured image \((.+)\) exceeds the (\d+) MB limit\. Please capture a smaller image or reduce its size and try again\.$/, 'err.sizeCapture', (m) => ({ size: m[1], limit: `${m[2]} MB` })],
  [/^This document \((.+)\) exceeds the maximum allowed size of (\d+) MB\. Please compress the file to \d+ MB or less before uploading\.$/, 'err.sizeMaxFile', (m) => ({ size: m[1], limit: `${m[2]} MB` })],
  [/^This image \((.+)\) exceeds the maximum allowed size of (\d+) MB\. Please capture a smaller image or compress it to \d+ MB or less\.$/, 'err.sizeMaxCapture', (m) => ({ size: m[1], limit: `${m[2]} MB` })],
  [/^The size of this file could not be determined, so it was not added\. Please try another file\.$/, 'err.sizeUnknown'],
  [/^The selected file could not be read\. Please try again or choose another file\.$/, 'err.fileRead'],
  [/^File picking is not available on this platform\.$/, 'err.noPicker'],
  [/^The camera is not available on this platform\.$/, 'err.noCamera'],
  [/^This is sample document data\. Import a real document to preview it\.$/, 'err.demoOpen'],
  [/^This is sample document data, so there is no file to share\. Import a real document first\.$/, 'err.demoShare'],
  [/^This document is not an image\.$/, 'err.notImage'],
  [/^The file for this document is missing from storage\.$/, 'err.fileMissing'],
  [/^The file for this document is missing from storage, so it cannot be shared\.$/, 'err.fileMissingShare'],
  [/^Could not prepare the file for sharing\. Please try again\.$/, 'err.sharePrepare'],
  [/^Please select at least one document to share\.$/, 'err.nothingSelected'],
  [/^Sharing is only available in the Android app\.$/, 'err.noShare'],
  [/^Some selected documents no longer exist\. Please review your selection\.$/, 'err.selectionStale'],
  [/^This document has no file that can be shared: ([\s\S]*?)(?: and (\d+) more)?\. Nothing was shared\.$/, 'err.zipUnavailable.one', (m) => ({ names: m[1], more: m[2] ? t('err.andMore', { n: m[2] }) : '' })],
  [/^These documents have no file that can be shared: ([\s\S]*?)(?: and (\d+) more)?\. Nothing was shared\.$/, 'err.zipUnavailable.other', (m) => ({ names: m[1], more: m[2] ? t('err.andMore', { n: m[2] }) : '' })],
  [/^Too many documents for one ZIP file\.$/, 'err.zipTooMany'],
  [/^The selected documents are too large for one ZIP file\. Select fewer documents\.$/, 'err.zipTooLarge'],
  [/^Not enough free storage to create the ZIP file\.$/, 'err.zipNoSpace'],
  [/^Could not create the ZIP file\. Please try again\.$/, 'zip.failed'],
  [/^Previewing is not available on this platform\.$/, 'err.noViewer'],
  [/^No app on this device can receive this file\.$/, 'err.noShareTarget'],
  [/^Sharing is not set up correctly for this file\.$/, 'err.shareConfig'],
  [/^Could not open the share sheet\. Please try again\.$/, 'err.shareSheet'],
  [/^The camera did not return a photo\.$/, 'err.captureNoPhoto'],
  [/^Camera access was denied\. Allow camera access for MyDocs in Android Settings, then try again\.$/, 'err.cameraDenied'],
  [/^No camera is available on this device\.$/, 'err.cameraUnavailable'],
  [/^Could not capture the photo\. Please try again\.$/, 'err.captureFailed'],
  [/^Too many files for one ZIP archive\.$/, 'err.zipEntries'],
  [/^The selected files are too large for one ZIP archive\.$/, 'err.zipBytes'],
  [/^This file is not a valid MyDocs backup\.$/, 'err.bkInvalid'],
  [/^The backup is damaged or incomplete, so it was not restored\. Your current data has not been changed\.$/, 'err.bkCorrupt'],
  [/^The backup could not be created\. Please try again\.$/, 'err.bkFailed'],
  [/^The restore failed\. Your existing data has been kept unchanged\.$/, 'err.bkRestoreFailed'],
  [/^The operation was cancelled\.$/, 'err.bkCancelled'],
  [/^The backup does not contain a readable database\.$/, 'err.bkNoDb'],
  [/^This backup was created by a newer version of MyDocs \(backup format (\d+)\)\. Please update MyDocs and try again\.$/, 'err.bkUnsupported', (m) => ({ v: m[1] })],
  [/^There is not enough free storage to restore this backup \(about (\d+) MB needed\)\. Free up space and try again\.$/, 'err.bkStorage', (m) => ({ mb: m[1] })],
  [/^Could not reach Google Drive\. Check your internet connection and try again\. Your backup file has been kept\.$/, 'err.driveOffline'],
  [/^Google Drive sign-in was not completed\. Your backup file has been kept\.$/, 'err.driveAuth'],
  [/^Google Drive sign-in was cancelled\. Your backup file has been kept\.$/, 'err.driveSignInCancelled'],
  [/^Permission to use Google Drive was not granted\. Your backup file has been kept\.$/, 'err.driveDenied'],
  [/^Google Drive sign-in is not available in this build of MyDocs\. Save the backup to your device instead\.$/, 'err.driveUnavailable'],
  [/^The upload to Google Drive failed\. Your backup file has been kept; you can try again\.$/, 'err.driveFailed'],
  [/^Google Drive has no free space left for this backup\.$/, 'err.driveQuota'],
  [/^Google Drive did not confirm the uploaded file\. Please try again\.$/, 'err.driveUnverified'],
  [/^The upload was cancelled\.$/, 'err.driveCancelled'],
  [/^MyDocs Basic can save up to (\d+) documents\. Delete a document or upgrade to Pro for unlimited documents\.$/, 'err.docLimit', (m) => ({ n: m[1] })],
  [/^Backup & Restore is a MyDocs Pro feature\. Upgrade to Pro to use it\.$/, 'err.proBackup'],
  [/^Google Drive backup is a MyDocs Pro feature\. Upgrade to Pro to use it\.$/, 'err.proDrive'],
  [/^Document sizes above 3 MB are a MyDocs Pro feature\. Upgrade to Pro to use them\.$/, 'err.proSize'],
  [/^This feature needs MyDocs Pro\. Upgrade to Pro to use it\.$/, 'err.proGeneric'],
  [/^Please enter a promo code\.$/, 'err.promoEmpty'],
  [/^This promo code is not valid\.$/, 'err.promoInvalid'],
  [/^This promo code has already been redeemed\.$/, 'err.promoRedeemed'],
  [/^This promo code has expired\.$/, 'err.promoExpired'],
  [/^This promo code is no longer active\.$/, 'err.promoDisabled'],
  [/^This promo code has reached its redemption limit\.$/, 'err.promoLimit'],
  [/^The Pro access from this promo code has already ended\.$/, 'err.promoEnded'],
  [/^Too many attempts\. Please wait a few minutes and try again\.$/, 'err.promoRate'],
  [/^Could not reach the server\. Check your internet connection and try again\.$/, 'err.promoNetwork'],
  [/^Promo codes are not available in this build yet\.$/, 'err.promoNotConfigured'],
  [/^The promo code could not be checked right now\. Please try again later\.$/, 'err.promoServer'],
  [/^Google Play purchases are not available on this device or in this build\.$/, 'err.billUnavailable'],
  [/^MyDocs Pro is not available for purchase right now\. Please try again later\.$/, 'err.billProduct'],
  [/^Could not reach Google Play\. Check your internet connection and try again\.$/, 'err.billOffline'],
  [/^The purchase could not be completed\. Please try again\.$/, 'err.billFailed'],
  [/^Your purchase could not be verified yet\. Pro unlocks as soon as it is confirmed; try Restore Purchases in a moment\.$/, 'err.billVerify'],
  [/^A purchase is already in progress\.$/, 'err.billBusy'],
];

/** Localised text for an error thrown by the service; unknown messages are returned unchanged (or `fallbackKey`). */
export function errorText(err, fallbackKey) {
  const message = String(err?.message ?? '');
  for (const [pattern, key, params] of ERROR_PATTERNS) {
    const m = message.match(pattern);
    if (m) return t(key, params?.(m));
  }
  if (message) return message;
  return fallbackKey ? t(fallbackKey) : '';
}

/**
 * Applies translations to every element marked in the HTML: data-i18n (text), data-i18n-aria-label,
 * data-i18n-placeholder, data-i18n-title and data-i18n-alt. Also sets <html lang>.
 */
export function applyStaticTranslations(root = document) {
  const doc = root.ownerDocument ?? root;
  doc.documentElement.lang = current;
  doc.documentElement.setAttribute('data-lang', current);
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const attr of ['aria-label', 'placeholder', 'title', 'alt']) {
    const data = `i18n${attr.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase())}`; // aria-label -> i18nAriaLabel
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.dataset[data]));
  }
  doc.documentElement.setAttribute('data-i18n-ready', '');
}
