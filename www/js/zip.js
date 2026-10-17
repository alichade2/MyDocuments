// Minimal streaming ZIP writer (STORE method: PDFs/JPEGs are already compressed). No dependencies, no DOM.
// Files are processed one at a time and written to the sink in base64 chunks, so memory use is about one file.

const enc = new TextEncoder();
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Incremental CRC-32. Start with 0xFFFFFFFF, feed chunks, finish with `(crc ^ 0xFFFFFFFF) >>> 0`. */
export function crc32Update(crc, bytes) {
  let c = crc;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}
export const crc32 = (bytes) => (crc32Update(0xffffffff, bytes) ^ 0xffffffff) >>> 0;

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** CRC and decoded size of a base64 string, decoded in slices so no full copy is kept. */
export function base64Info(b64, sliceChars = 1 << 20) {
  let crc = 0xffffffff;
  let size = 0;
  for (let i = 0; i < b64.length; i += sliceChars) { // sliceChars is a multiple of 4, so every slice decodes on its own
    const bytes = base64ToBytes(b64.slice(i, i + sliceChars));
    crc = crc32Update(crc, bytes);
    size += bytes.length;
  }
  return { crc: (crc ^ 0xffffffff) >>> 0, size };
}

/* ---------- entry names ---------- */

const ILLEGAL = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;

/** One path segment: no separators, no control characters, never "." / ".." / empty. */
export function sanitizeSegment(name, fallback = 'document', max = 100) {
  const cleaned = String(name ?? '').replace(ILLEGAL, '_').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, max).replace(/[.\s]+$/g, '');
  return cleaned || fallback;
}

/**
 * Turns [{category, name, ext}] into unique, safe entry paths "Category/Name.ext".
 * Collisions (case-insensitive, for Windows/macOS unzip) get " (2)", " (3)", ... so nothing is overwritten or dropped.
 */
export function uniqueEntryPaths(items) {
  const used = new Set();
  return items.map(({ category, name, ext }) => {
    const folder = sanitizeSegment(category, 'Documents');
    const base = sanitizeSegment(name, 'document');
    const suffix = ext ? `.${sanitizeSegment(ext, 'bin', 10)}` : '';
    let path = `${folder}/${base}${suffix}`;
    for (let n = 2; used.has(path.toLowerCase()); n++) path = `${folder}/${base} (${n})${suffix}`;
    used.add(path.toLowerCase());
    return path;
  });
}

/* ---------- binary records ---------- */

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(+date) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function localHeader(nameBytes, { crc, size, dt }) {
  const b = new Uint8Array(30 + nameBytes.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x04034b50, true);
  v.setUint16(4, 20, true); // version needed
  v.setUint16(6, 0x0800, true); // UTF-8 names
  v.setUint16(8, 0, true); // STORE
  v.setUint16(10, dt.time, true);
  v.setUint16(12, dt.date, true);
  v.setUint32(14, crc, true);
  v.setUint32(18, size, true);
  v.setUint32(22, size, true);
  v.setUint16(26, nameBytes.length, true);
  b.set(nameBytes, 30);
  return b;
}

function centralRecord(nameBytes, { crc, size, dt, offset }) {
  const b = new Uint8Array(46 + nameBytes.length);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x02014b50, true);
  v.setUint16(4, 20, true); // version made by
  v.setUint16(6, 20, true);
  v.setUint16(8, 0x0800, true);
  v.setUint16(10, 0, true);
  v.setUint16(12, dt.time, true);
  v.setUint16(14, dt.date, true);
  v.setUint32(16, crc, true);
  v.setUint32(20, size, true);
  v.setUint32(24, size, true);
  v.setUint16(28, nameBytes.length, true);
  v.setUint32(42, offset, true);
  b.set(nameBytes, 46);
  return b;
}

function endRecord(count, cdSize, cdOffset) {
  const b = new Uint8Array(22);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, count, true);
  v.setUint16(10, count, true);
  v.setUint32(12, cdSize, true);
  v.setUint32(16, cdOffset, true);
  return b;
}

export const ZIP_LIMITS = { maxEntries: 5000, maxBytes: 0xffffffff - 1024 * 1024 }; // classic ZIP (no ZIP64) limits

/**
 * Writes a ZIP archive through `append(base64)`; each entry's content is read on demand.
 * @param {object} o
 * @param {Array<{path:string, date?:Date, read:()=>Promise<string>}>} o.entries  `read` resolves to the file's base64
 * @param {(b64:string)=>Promise<void>} o.append  sink; every call receives an independently decodable base64 chunk
 * @param {(done:number,total:number,path:string)=>void} [o.onProgress]
 * @returns {Promise<{count:number, bytes:number}>}
 */
export async function writeZip({ entries, append, onProgress, chunkChars = 1 << 21 }) {
  if (!entries.length) throw new Error('A ZIP archive needs at least one entry.');
  if (entries.length > ZIP_LIMITS.maxEntries) throw new Error('Too many files for one ZIP archive.');
  const central = [];
  let offset = 0;
  for (const [i, entry] of entries.entries()) {
    onProgress?.(i, entries.length, entry.path);
    await new Promise((r) => setTimeout(r, 0)); // let the UI paint between files
    const nameBytes = enc.encode(entry.path);
    const data = await entry.read();
    const { crc, size } = base64Info(data);
    if (offset + size + 30 + nameBytes.length > ZIP_LIMITS.maxBytes) throw new Error('The selected files are too large for one ZIP archive.');
    const info = { crc, size, dt: dosDateTime(entry.date), offset };
    const header = localHeader(nameBytes, info);
    await append(bytesToBase64(header));
    for (let p = 0; p < data.length; p += chunkChars) await append(data.slice(p, p + chunkChars)); // original base64, no re-encoding
    central.push(centralRecord(nameBytes, info));
    offset += header.length + size;
  }
  const cdSize = central.reduce((n, r) => n + r.length, 0);
  for (const r of central) await append(bytesToBase64(r));
  await append(bytesToBase64(endRecord(central.length, cdSize, offset)));
  onProgress?.(entries.length, entries.length, '');
  return { count: central.length, bytes: offset + cdSize + 22 };
}
