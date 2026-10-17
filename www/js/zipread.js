// Random-access ZIP reader for MyDocs backups. It never trusts the archive: names are checked for path tricks, sizes are
// capped (zip bombs), every entry's CRC-32 is verified when it is read, and only STORE / DEFLATE entries are accepted.
// The source is anything that can read a byte range, so a large backup is never loaded into memory as a whole.
import { crc32 } from './zip.js';

export class ZipError extends Error {
  constructor(code, message) { super(message); this.name = 'ZipError'; this.code = code; }
}

export const ZIP_READ_LIMITS = { maxEntries: 20000, maxEntryBytes: 200 * 1000 * 1000, maxTotalBytes: 2 * 1000 * 1000 * 1000, maxDirectoryBytes: 16 * 1024 * 1024 };

const dec = new TextDecoder('utf-8', { fatal: false });

/** An entry name must stay inside the archive: no absolute paths, drive letters, backslashes, NUL bytes or ".." segments. */
export function isSafeEntryName(name) {
  if (typeof name !== 'string' || !name || name.length > 512) return false;
  if (/[\u0000-\u001f\u007f\\]/.test(name) || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return name.split('/').every((segment, i, all) => (segment === '' ? i === all.length - 1 : segment !== '.' && segment !== '..'));
}

async function inflateRaw(bytes, expectedSize) {
  if (typeof DecompressionStream === 'undefined') throw new ZipError('ZIP_UNSUPPORTED', 'This backup uses compression that this device cannot read.');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const out = new Uint8Array(expectedSize);
  let used = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (used + value.length > expectedSize) { await reader.cancel(); throw new ZipError('ZIP_CORRUPT', 'An entry is larger than its header says.'); }
    out.set(value, used);
    used += value.length;
  }
  if (used !== expectedSize) throw new ZipError('ZIP_CORRUPT', 'An entry is smaller than its header says.');
  return out;
}

/**
 * @param {{ size: number, read(offset: number, length: number): Promise<Uint8Array> }} source
 * @returns {Promise<{ entries: Map<string, object>, list: object[], read(entry): Promise<Uint8Array> }>}
 */
export async function openZip(source, limits = ZIP_READ_LIMITS) {
  const size = Number(source?.size);
  if (!Number.isFinite(size) || size < 22) throw new ZipError('ZIP_INVALID', 'The file is not a ZIP archive.');
  const tailLength = Math.min(size, 22 + 65535);
  const tail = await source.read(size - tailLength, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('ZIP_INVALID', 'The file is not a ZIP archive.');
  const v = new DataView(tail.buffer, tail.byteOffset + eocd, 22);
  const count = v.getUint16(10, true);
  const cdSize = v.getUint32(12, true);
  const cdOffset = v.getUint32(16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError('ZIP_UNSUPPORTED', 'ZIP64 archives are not supported.');
  if (count > limits.maxEntries || cdSize > limits.maxDirectoryBytes) throw new ZipError('ZIP_INVALID', 'The archive is not valid.');
  if (cdOffset + cdSize > size) throw new ZipError('ZIP_INVALID', 'The archive is not valid.');
  const directory = cdSize ? await source.read(cdOffset, cdSize) : new Uint8Array(0);
  const dv = new DataView(directory.buffer, directory.byteOffset, directory.length);

  const entries = new Map();
  const list = [];
  const lowerNames = new Set();
  let total = 0;
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > directory.length || dv.getUint32(p, true) !== 0x02014b50) throw new ZipError('ZIP_INVALID', 'The archive directory is damaged.');
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const compressedSize = dv.getUint32(p + 20, true);
    const uncompressedSize = dv.getUint32(p + 24, true);
    const nameLength = dv.getUint16(p + 28, true);
    const extraLength = dv.getUint16(p + 30, true);
    const commentLength = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    if (p + 46 + nameLength + extraLength + commentLength > directory.length) throw new ZipError('ZIP_INVALID', 'The archive directory is damaged.');
    const name = dec.decode(directory.subarray(p + 46, p + 46 + nameLength));
    p += 46 + nameLength + extraLength + commentLength;
    if (!isSafeEntryName(name)) throw new ZipError('ZIP_UNSAFE', 'The archive contains an unsafe file name.');
    if (name.endsWith('/')) continue; // directory entries carry no data
    if (flags & 0x1) throw new ZipError('ZIP_UNSUPPORTED', 'Encrypted archives are not supported.');
    if (method !== 0 && method !== 8) throw new ZipError('ZIP_UNSUPPORTED', 'The archive uses an unsupported compression method.');
    if (uncompressedSize > limits.maxEntryBytes || compressedSize > limits.maxEntryBytes) throw new ZipError('ZIP_INVALID', 'An entry in the archive is too large.');
    if (method === 0 && compressedSize !== uncompressedSize) throw new ZipError('ZIP_CORRUPT', 'An entry in the archive is damaged.');
    if (localOffset + 30 > cdOffset || localOffset + 30 + compressedSize > cdOffset) throw new ZipError('ZIP_CORRUPT', 'An entry in the archive is damaged.');
    total += uncompressedSize;
    if (total > limits.maxTotalBytes) throw new ZipError('ZIP_INVALID', 'The archive expands to too much data.');
    const key = name.toLowerCase();
    if (lowerNames.has(key)) throw new ZipError('ZIP_INVALID', 'The archive contains the same file twice.');
    lowerNames.add(key);
    const entry = { name, method, crc, compressedSize, size: uncompressedSize, localOffset };
    entries.set(name, entry);
    list.push(entry);
  }

  async function read(entry) {
    const header = await source.read(entry.localOffset, 30);
    const hv = new DataView(header.buffer, header.byteOffset, header.length);
    if (header.length < 30 || hv.getUint32(0, true) !== 0x04034b50) throw new ZipError('ZIP_CORRUPT', 'An entry in the archive is damaged.');
    const dataStart = entry.localOffset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
    if (dataStart + entry.compressedSize > cdOffset) throw new ZipError('ZIP_CORRUPT', 'An entry in the archive is damaged.');
    const raw = entry.compressedSize ? await source.read(dataStart, entry.compressedSize) : new Uint8Array(0);
    if (raw.length !== entry.compressedSize) throw new ZipError('ZIP_CORRUPT', 'An entry in the archive is cut short.');
    const data = entry.method === 0 ? raw : await inflateRaw(raw, entry.size);
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw new ZipError('ZIP_CORRUPT', 'An entry in the archive is damaged.');
    return data;
  }

  return { entries, list, read };
}

/** A ZIP source over bytes already in memory (tests, small archives). */
export const bytesSource = (bytes) => ({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) });
