// Document size limit: one place that knows the allowed sizes, the saved setting and how a size is judged.
// Used by file upload, camera capture and the final import step, so every import path applies the same rule.
//
// Convention: 1 MB = 1,000,000 bytes (decimal). A file passes when its real size in bytes is <= limit * 1,000,000;
// sizes are never rounded before they are compared (rounding is only for the text shown to the user).

export const MB = 1_000_000;
export const SIZE_LIMIT_OPTIONS_MB = [3, 5, 8, 12, 15];
export const DEFAULT_SIZE_LIMIT_MB = 5;
export const MAX_SIZE_LIMIT_MB = 15; // absolute maximum: nothing larger is ever accepted, whatever the setting
export const SIZE_LIMIT_KEY = 'mydocs.sizeLimitMb';

export const normalizeSizeLimitMb = (value) => {
  const n = Number(value);
  return SIZE_LIMIT_OPTIONS_MB.includes(n) ? n : DEFAULT_SIZE_LIMIT_MB;
};

export function loadSizeLimitMb(storage = globalThis.localStorage) {
  try { return normalizeSizeLimitMb(storage?.getItem(SIZE_LIMIT_KEY)); } catch { return DEFAULT_SIZE_LIMIT_MB; }
}

/** Returns true when the preference was stored. */
export function saveSizeLimitMb(mb, storage = globalThis.localStorage) {
  try { storage.setItem(SIZE_LIMIT_KEY, String(normalizeSizeLimitMb(mb))); return true; } catch { return false; }
}

let currentMb = DEFAULT_SIZE_LIMIT_MB; // the user's saved preference
let capMb = null; // set by the entitlement system: Basic users can never exceed this, whatever they have saved
const effectiveMb = () => (capMb === null ? currentMb : Math.min(currentMb, capMb));
/** The limit in force right now: the saved preference, lowered by the plan's cap (applies immediately to the next upload or capture). */
export const getSizeLimitMb = effectiveMb;
/** What the user chose in Settings (kept while a cap hides it, so upgrading brings it back). */
export const getSizeLimitPreferenceMb = () => currentMb;
export function setSizeLimitMb(mb) {
  currentMb = normalizeSizeLimitMb(mb);
  return effectiveMb();
}
export const getSizeCapMb = () => capMb;
/** Upper bound from the current plan (null = none). Normalised to one of the allowed sizes; never raises the limit. */
export function setSizeCapMb(mb) {
  capMb = mb === null || mb === undefined ? null : normalizeSizeLimitMb(mb);
  return effectiveMb();
}
export const sizeLimitBytes = (mb = effectiveMb()) => mb * MB;

/** Real byte length of base64 data without decoding it. */
export function byteLengthOfBase64(base64) {
  const text = String(base64 ?? '');
  if (!text) return 0;
  const padding = (text.match(/=+$/) ?? [''])[0].length;
  return Math.floor((text.length * 3) / 4) - padding;
}

/**
 * Readable size for messages and lists (decimal units). With `ceil` the value is rounded UP, so a file that is just over
 * a limit never reads as exactly the limit ("5.01 MB", not "5 MB").
 */
export function formatSize(bytes, { ceil = false, atLeast = false } = {}) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  const plus = atLeast ? '+' : '';
  if (n < 1000) return `${n} B${plus}`;
  const round = ceil ? Math.ceil : Math.round;
  if (n < MB) return `${round(n / 1000)} KB${plus}`;
  const value = round((n / MB) * 100) / 100;
  return `${Number.isInteger(value) ? value : value.toFixed(2).replace(/0$/, '')} MB${plus}`;
}

/**
 * Judges a size in bytes. Returns null when the file may be used, otherwise { code, message, size, limitMb }.
 *   FILE_SIZE_UNKNOWN  the size is not a real number (never guessed, never allowed)
 *   FILE_TOO_LARGE_MAX more than the 15 MB absolute maximum (under every setting)
 *   FILE_TOO_LARGE     more than the selected limit (which is 15 MB or lower)
 * kind: 'file' (picked from storage) or 'capture' (camera image); only the wording differs.
 */
export function checkSize(bytes, { kind = 'file', limitMb: requested = effectiveMb(), atLeast = false } = {}) {
  const limitMb = normalizeSizeLimitMb(requested);
  const size = typeof bytes === 'number' ? bytes : Number.NaN;
  if (!Number.isFinite(size) || size < 0) {
    return { code: 'FILE_SIZE_UNKNOWN', message: 'The size of this file could not be determined, so it was not added. Please try another file.', size: null, limitMb };
  }
  const shown = formatSize(size, { ceil: true, atLeast });
  if (size > MAX_SIZE_LIMIT_MB * MB) {
    const message = kind === 'capture'
      ? `This image (${shown}) exceeds the maximum allowed size of ${MAX_SIZE_LIMIT_MB} MB. Please capture a smaller image or compress it to ${MAX_SIZE_LIMIT_MB} MB or less.`
      : `This document (${shown}) exceeds the maximum allowed size of ${MAX_SIZE_LIMIT_MB} MB. Please compress the file to ${MAX_SIZE_LIMIT_MB} MB or less before uploading.`;
    return { code: 'FILE_TOO_LARGE_MAX', message, size, limitMb };
  }
  if (size > limitMb * MB) {
    const message = kind === 'capture'
      ? `Captured image (${shown}) exceeds the ${limitMb} MB limit. Please capture a smaller image or reduce its size and try again.`
      : `File size (${shown}) exceeds the ${limitMb} MB limit. Please select a smaller file or compress the document and try again.`;
    return { code: 'FILE_TOO_LARGE', message, size, limitMb };
  }
  return null;
}
