// Pure search helpers (no DOM, no database): query normalisation and date parsing.
// Stored dates are ISO-8601 UTC strings ("2026-10-17T07:01:02.345Z"); the UI shows their first 10 characters.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export const normalizeQuery = (q) => String(q ?? '').replace(/\s+/g, ' ').trim();

/** Escapes LIKE wildcards so user input is matched literally (use with ESCAPE '\'). */
export const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const pad = (n) => String(n).padStart(2, '0');

function validDate(y, m, d) {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function monthFromName(word) {
  const w = word.toLowerCase().replace(/\.$/, '');
  if (w.length < 3) return 0;
  const i = MONTHS.findIndex((m) => m === w || (w.length <= 4 && m.startsWith(w)) || (w === 'sept' && m === 'september'));
  return i + 1; // 0 when not a month name
}

/**
 * Interprets a query as a date (full or partial) and returns a LIKE pattern for ISO timestamps, or null.
 * Day-first is assumed for ambiguous numeric dates (dd/mm/yyyy); mm/dd/yyyy is used when only that reading is valid.
 * Supported: 2026-10-17, 17/10/2026, 17-10-2026, 17.10.2026, 2026/10/17, 2026-10, 10/2026, 2026, 17/10 (any year),
 *            "17 Oct 2026", "Oct 17, 2026", "October 2026".
 */
export function parseDateQuery(raw) {
  const q = normalizeQuery(raw).toLowerCase();
  let m;

  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(q))) {
    const [y, mo, d] = [+m[1], +m[2], +m[3]];
    return validDate(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}%` : null;
  }
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(q))) {
    const [a, b, y] = [+m[1], +m[2], +m[3]];
    if (validDate(y, b, a)) return `${y}-${pad(b)}-${pad(a)}%`; // dd/mm/yyyy
    if (validDate(y, a, b)) return `${y}-${pad(a)}-${pad(b)}%`; // mm/dd/yyyy
    return null;
  }
  if ((m = /^(\d{4})[-/.](\d{1,2})$/.exec(q))) {
    const [y, mo] = [+m[1], +m[2]];
    return validDate(y, mo, 1) ? `${y}-${pad(mo)}-%` : null;
  }
  if ((m = /^(\d{1,2})[-/.](\d{4})$/.exec(q))) {
    const [mo, y] = [+m[1], +m[2]];
    return validDate(y, mo, 1) ? `${y}-${pad(mo)}-%` : null;
  }
  if ((m = /^(\d{1,2})[-/.](\d{1,2})$/.exec(q))) { // day/month without a year: any year
    const [a, b] = [+m[1], +m[2]];
    if (validDate(2000, b, a)) return `%-${pad(b)}-${pad(a)}T%`;
    if (validDate(2000, a, b)) return `%-${pad(a)}-${pad(b)}T%`;
    return null;
  }
  if ((m = /^(\d{4})$/.exec(q))) return +m[1] >= 1900 && +m[1] <= 2200 ? `${m[1]}-%` : null;

  if ((m = /^(\d{1,2})\s+([a-z.]{3,10}),?\s+(\d{4})$/.exec(q))) { // 17 oct 2026
    const mo = monthFromName(m[2]);
    return mo && validDate(+m[3], mo, +m[1]) ? `${m[3]}-${pad(mo)}-${pad(+m[1])}%` : null;
  }
  if ((m = /^([a-z.]{3,10})\s+(\d{1,2}),?\s+(\d{4})$/.exec(q))) { // oct 17, 2026
    const mo = monthFromName(m[1]);
    return mo && validDate(+m[3], mo, +m[2]) ? `${m[3]}-${pad(mo)}-${pad(+m[2])}%` : null;
  }
  if ((m = /^([a-z.]{3,10})\s+(\d{4})$/.exec(q))) { // october 2026
    const mo = monthFromName(m[1]);
    return mo && validDate(+m[2], mo, 1) ? `${m[2]}-${pad(mo)}-%` : null;
  }
  return null;
}

/** SQL LIKE semantics in JS (% and _ wildcards, case-sensitive) for the in-memory preview repository. */
export function likeToRegExp(pattern) {
  return new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`);
}

/** Same matching rules as the SQL query, for the in-memory preview repository. */
export function matchesDocument(doc, rawQuery) {
  const text = normalizeQuery(rawQuery).toLowerCase();
  if (!text) return false;
  if (doc.name.toLowerCase().includes(text) || String(doc.originalFilename ?? '').toLowerCase().includes(text)) return true;
  const pattern = parseDateQuery(text);
  if (!pattern) return false;
  const re = likeToRegExp(pattern);
  return re.test(doc.createdAt ?? '') || re.test(doc.expiryDate ?? '');
}
