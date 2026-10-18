// Configurable document size limit: the setting, the single size rule, the upload / capture / import paths and the messages.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  MB, SIZE_LIMIT_OPTIONS_MB, DEFAULT_SIZE_LIMIT_MB, MAX_SIZE_LIMIT_MB, SIZE_LIMIT_KEY, normalizeSizeLimitMb, loadSizeLimitMb, saveSizeLimitMb,
  getSizeLimitMb, setSizeLimitMb, sizeLimitBytes, byteLengthOfBase64, formatSize, checkSize,
} from '../www/js/sizelimit.js';
import { createDatabase } from '../www/js/database.js';
import { createDocumentService, capacitorAdapters, readLimited, DocumentError, enforceSize } from '../www/js/documents.js';
import { createMockService } from '../www/js/mock.js';
import { buildSettingsSections } from '../www/js/menu.js';
import { errorText, setLanguage } from '../www/js/i18n.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const b64 = (bytes) => Buffer.alloc(bytes, 65).toString('base64'); // decodes to exactly `bytes` bytes
const memStorage = (init = {}) => { const m = new Map(Object.entries(init)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
afterEach(() => { setSizeLimitMb(DEFAULT_SIZE_LIMIT_MB); setLanguage('en'); delete globalThis.__mydocsPreviewBytes; });

function nodeDriver() {
  const sqlite = new DatabaseSync(':memory:');
  return {
    sqlite,
    async open() {}, async close() {}, async exec(sql) { sqlite.exec(sql); },
    async all(sql, p = []) { return sqlite.prepare(sql).all(...p); },
    async run(sql, p = []) { const r = sqlite.prepare(sql).run(...p); return { changes: r.changes, lastId: Number(r.lastInsertRowid) }; },
    async begin() { sqlite.exec('BEGIN'); }, async commit() { sqlite.exec('COMMIT'); }, async rollback() { sqlite.exec('ROLLBACK'); },
  };
}
function fileStore() {
  const files = new Map();
  return {
    files,
    async write(path, data) { files.set(path, data); }, async remove(path) { files.delete(path); },
    async exists(path) { return files.has(path); }, async list() { return []; }, async uri(p) { return `file:///${p}`; }, async src(p) { return p; },
  };
}
async function setup(opts = {}) {
  const driver = nodeDriver();
  const db = createDatabase(driver);
  await db.init();
  const storage = fileStore();
  const svc = createDocumentService({ db, storage, ...opts });
  return { svc, storage, driver };
}
const docCount = (driver) => driver.sqlite.prepare('SELECT COUNT(*) c FROM documents WHERE is_demo = 0').get().c;
const upload = (bytes, extra = {}) => ({ name: 'scan.pdf', mimeType: 'application/pdf', size: bytes, data: b64(bytes), ...extra });

/* ---------------- the setting ---------------- */

test('options are exactly 3, 5, 8, 12 and 15 MB; the default is 5 MB; 1 MB = 1,000,000 bytes', () => {
  assert.deepEqual(SIZE_LIMIT_OPTIONS_MB, [3, 5, 8, 12, 15]);
  assert.equal(DEFAULT_SIZE_LIMIT_MB, 5);
  assert.equal(MAX_SIZE_LIMIT_MB, 15);
  assert.equal(MB, 1_000_000);
  assert.equal(getSizeLimitMb(), 5);
  assert.equal(sizeLimitBytes(), 5_000_000);
  assert.equal(sizeLimitBytes(15), 15_000_000);
});

test('the choice is stored as a stable number and restored; missing, invalid or unreadable values mean 5 MB', () => {
  assert.equal(loadSizeLimitMb(memStorage()), 5);
  const s = memStorage();
  for (const mb of SIZE_LIMIT_OPTIONS_MB) { assert.equal(saveSizeLimitMb(mb, s), true); assert.equal(s.m.get(SIZE_LIMIT_KEY), String(mb)); assert.equal(loadSizeLimitMb(s), mb); }
  for (const bad of ['', 'abc', '7', '20', '0', '-5', '5.5', null]) assert.equal(loadSizeLimitMb(memStorage({ [SIZE_LIMIT_KEY]: bad })), 5, String(bad));
  assert.equal(loadSizeLimitMb({ getItem() { throw new Error('denied'); } }), 5);
  assert.equal(saveSizeLimitMb(8, { setItem() { throw new Error('denied'); } }), false);
  assert.equal(normalizeSizeLimitMb('12'), 12);
  assert.equal(normalizeSizeLimitMb(99), 5);
});

test('changing the limit takes effect immediately for the next check', () => {
  assert.equal(checkSize(4_000_000), null);
  setSizeLimitMb(3);
  assert.equal(checkSize(4_000_000).code, 'FILE_TOO_LARGE');
  setSizeLimitMb(8);
  assert.equal(checkSize(7_000_000), null);
  assert.equal(setSizeLimitMb('bogus'), 5);
});

test('Settings has a Document Size Limit dropdown with the five options and shows the current value', () => {
  const row = buildSettingsSections({ sizeLimitMb: 12 }).flatMap((s) => s.rows).find((r) => r.id === 'size-limit');
  assert.equal(row.label, 'Document Size Limit');
  assert.equal(row.description, 'Choose the maximum file size allowed for documents.');
  assert.deepEqual(row.select.options.map((o) => o.label), ['3 MB', '5 MB', '8 MB', '12 MB', '15 MB']);
  assert.equal(row.select.value, 12);
  assert.equal(buildSettingsSections().flatMap((s) => s.rows).find((r) => r.id === 'size-limit').select.value, 5);
});

/* ---------------- the rule ---------------- */

test('boundaries for every limit: the limit itself passes, one byte more fails (decimal MB, no rounding)', () => {
  for (const mb of SIZE_LIMIT_OPTIONS_MB) {
    assert.equal(checkSize(mb * MB, { limitMb: mb }), null, `${mb} MB exactly`);
    assert.equal(checkSize(mb * MB - 1, { limitMb: mb }), null);
    const over = checkSize(mb * MB + 1, { limitMb: mb });
    assert.equal(over.code, mb === 15 ? 'FILE_TOO_LARGE_MAX' : 'FILE_TOO_LARGE', `${mb} MB + 1`);
  }
  // the examples from the requirements, limit 5 MB
  assert.equal(checkSize(4 * MB, { limitMb: 5 }), null);
  assert.equal(checkSize(5 * MB, { limitMb: 5 }), null);
  assert.equal(checkSize(7 * MB, { limitMb: 5 }).code, 'FILE_TOO_LARGE');
  assert.equal(checkSize(4_999_999, { limitMb: 5 }), null);
  assert.equal(checkSize(5_000_001, { limitMb: 5 }).code, 'FILE_TOO_LARGE'); // never rounded down to "5 MB"
});

test('nothing above 15 MB is ever accepted; between the setting and 15 MB the selected limit decides', () => {
  for (const mb of SIZE_LIMIT_OPTIONS_MB) assert.equal(checkSize(15_000_001, { limitMb: mb }).code, 'FILE_TOO_LARGE_MAX', `limit ${mb}`);
  assert.equal(checkSize(100 * MB, { limitMb: 15 }).code, 'FILE_TOO_LARGE_MAX');
  const ten = checkSize(10 * MB, { limitMb: 5 });
  assert.equal(ten.code, 'FILE_TOO_LARGE'); // below the absolute maximum, rejected by the lower setting
  assert.match(ten.message, /5 MB limit/);
  assert.equal(checkSize(10 * MB, { limitMb: 12 }), null);
});

test('unknown sizes are never allowed or guessed', () => {
  for (const bad of [undefined, null, NaN, -1, '5000000', Infinity]) assert.equal(checkSize(bad)?.code, 'FILE_SIZE_UNKNOWN', String(bad));
  assert.equal(checkSize(0), null); // an empty file is judged elsewhere (EMPTY_FILE)
});

test('messages name the actual size, the limit and what to do; capture wording differs from file wording', () => {
  const file = checkSize(7 * MB, { limitMb: 5 }).message;
  assert.equal(file, 'File size (7 MB) exceeds the 5 MB limit. Please select a smaller file or compress the document and try again.');
  const shot = checkSize(5_000_001, { kind: 'capture', limitMb: 5 }).message;
  assert.equal(shot, 'Captured image (5.01 MB) exceeds the 5 MB limit. Please capture a smaller image or reduce its size and try again.');
  assert.equal(checkSize(20 * MB, { limitMb: 15 }).message, 'This document (20 MB) exceeds the maximum allowed size of 15 MB. Please compress the file to 15 MB or less before uploading.');
  assert.match(checkSize(20 * MB, { kind: 'capture' }).message, /^This image \(20 MB\) exceeds the maximum allowed size of 15 MB\./);
  assert.match(checkSize(NaN).message, /could not be determined/);
});

test('readable sizes use decimal units and round up in messages', () => {
  assert.equal(formatSize(999), '999 B');
  assert.equal(formatSize(1500), '2 KB');
  assert.equal(formatSize(1500, { ceil: true }), '2 KB');
  assert.equal(formatSize(4_812_345), '4.81 MB');
  assert.equal(formatSize(4_812_345, { ceil: true }), '4.82 MB');
  assert.equal(formatSize(7_000_000), '7 MB');
  assert.equal(formatSize(5_000_001, { ceil: true }), '5.01 MB');
  assert.equal(formatSize(15_000_000, { atLeast: true }), '15 MB+');
  assert.equal(byteLengthOfBase64(b64(1234)), 1234);
  assert.equal(byteLengthOfBase64(''), 0);
});

/* ---------------- import boundary (every path ends here) ---------------- */

test('importFile accepts a file exactly at the limit and rejects one byte more, for each limit; nothing is saved when rejected', async () => {
  for (const mb of SIZE_LIMIT_OPTIONS_MB) {
    setSizeLimitMb(mb);
    const { svc, storage, driver } = await setup();
    const ok = await svc.importFile(1, upload(mb * MB), 'At the limit');
    assert.equal(ok.fileSize, mb * MB);
    assert.equal(docCount(driver), 1);
    const filesBefore = storage.files.size;
    await assert.rejects(svc.importFile(1, upload(mb * MB + 1)), (e) => e instanceof DocumentError && /^FILE_TOO_LARGE/.test(e.code));
    assert.equal(docCount(driver), 1, `${mb} MB: no record for the rejected file`);
    assert.equal(storage.files.size, filesBefore, `${mb} MB: no file written`);
  }
});

test('the real size of the data decides, not the size the caller claims', async () => {
  const { svc, driver } = await setup();
  await assert.rejects(svc.importFile(1, upload(6 * MB, { size: 100 })), { code: 'FILE_TOO_LARGE' }); // big data, small claim
  await assert.rejects(svc.importFile(1, { name: 'a.pdf', size: 20 * MB, data: 'QUJD' }), { code: 'FILE_TOO_LARGE_MAX' }); // small data, big claim
  await assert.rejects(svc.importFile(1, { name: 'a.pdf', size: undefined, data: b64(6 * MB) }), { code: 'FILE_TOO_LARGE' });
  assert.equal(docCount(driver), 0);
  const saved = await svc.importFile(1, { name: 'a.pdf', size: 100, data: 'QUJD' });
  assert.equal(saved.fileSize, 3); // the stored size is the real one
  assert.equal(extName(saved.originalFilename), 'pdf'); // original file name and extension untouched
});
const extName = (n) => n.split('.').pop();

test('lowering the limit never touches documents that are already saved; raising it allows larger files again', async () => {
  const { svc } = await setup();
  setSizeLimitMb(15);
  const big = await svc.importFile(1, upload(14 * MB), 'Big one');
  setSizeLimitMb(3);
  assert.equal((await svc.get(big.id)).fileSize, 14 * MB); // still there, unchanged
  assert.equal((await svc.list(1)).filter((d) => !d.isDemo).length, 1);
  await assert.rejects(svc.importFile(1, upload(4 * MB)), { code: 'FILE_TOO_LARGE' });
  setSizeLimitMb(5);
  assert.ok(await svc.importFile(1, upload(4 * MB), 'Fits now'));
});

test('a camera image is judged like a document, with its own wording, and is not saved when rejected', async () => {
  const { svc, driver } = await setup();
  const shot = (bytes) => ({ name: 'Captured_1.jpg', mimeType: 'image/jpeg', size: bytes, data: b64(bytes), source: 'camera' });
  assert.ok(await svc.importFile(1, shot(5 * MB), 'At limit photo'));
  await assert.rejects(svc.importFile(1, shot(5 * MB + 1)), (e) => e.code === 'FILE_TOO_LARGE' && /^Captured image \(5\.01 MB\) exceeds the 5 MB limit/.test(e.message));
  await assert.rejects(svc.importFile(1, shot(16 * MB)), (e) => e.code === 'FILE_TOO_LARGE_MAX' && /^This image/.test(e.message));
  assert.equal(docCount(driver), 1);
});

test('enforceSize attaches the numbers to the error', () => {
  assert.throws(() => enforceSize(7 * MB, 'file'), (e) => e.code === 'FILE_TOO_LARGE' && e.size === 7 * MB && e.limitMb === 5);
  assert.doesNotThrow(() => enforceSize(5 * MB, 'file'));
});

/* ---------------- picking a file (Storage Access Framework) ---------------- */

test('pickFile: a reported size over the limit is rejected BEFORE any byte is read', async () => {
  let reads = 0;
  const picker = { pick: async () => ({ name: 'big.pdf', mimeType: 'application/pdf', size: 7 * MB, read: async () => { reads += 1; return { data: 'QUJD', size: 3 }; } }) };
  const { svc } = await setup({ picker });
  await assert.rejects(svc.pickFile(), { code: 'FILE_TOO_LARGE' });
  assert.equal(reads, 0);
  setSizeLimitMb(8);
  assert.ok(await svc.pickFile()); // 7 MB is fine under an 8 MB limit
  assert.equal(reads, 1);
});

test('pickFile: unknown size is measured while reading; oversize results and lying metadata are rejected', async () => {
  const mk = (size, result) => setup({ picker: { pick: async () => ({ name: 'a.pdf', mimeType: 'application/pdf', size, read: async () => result }) } });
  const unknownOk = await mk(0, { data: b64(1000), size: 1000 });
  assert.deepEqual(await unknownOk.svc.pickFile(), { name: 'a.pdf', mimeType: 'application/pdf', size: 1000, data: b64(1000) });
  const unknownBig = await mk(0, { tooLarge: true, size: 9 * MB });
  await assert.rejects(unknownBig.svc.pickFile(), { code: 'FILE_TOO_LARGE' });
  const huge = await mk(0, { tooLarge: true, size: 100 * MB, atLeast: true });
  await assert.rejects(huge.svc.pickFile(), (e) => e.code === 'FILE_TOO_LARGE_MAX' && /100 MB\+/.test(e.message));
  const liar = await mk(1000, { data: b64(6 * MB), size: 6 * MB }); // metadata says 1 KB, the bytes say 6 MB
  await assert.rejects(liar.svc.pickFile(), { code: 'FILE_TOO_LARGE' });
});

test('pickFile with an adapter that already returns data is validated too', async () => {
  const { svc } = await setup({ picker: { pick: async () => ({ name: 'a.pdf', mimeType: 'application/pdf', size: 10, data: b64(9 * MB) }) } });
  await assert.rejects(svc.pickFile(), { code: 'FILE_TOO_LARGE' });
});

test('importFromPicker goes through the same size checks', async () => {
  const { svc, driver } = await setup({ picker: { pick: async () => ({ name: 'a.pdf', mimeType: 'application/pdf', size: 9 * MB, read: async () => ({ data: 'QUJD', size: 3 }) }) } });
  await assert.rejects(svc.importFromPicker(1), { code: 'FILE_TOO_LARGE' });
  assert.equal(docCount(driver), 0);
});

/* ---------------- camera ---------------- */

test('capturePhoto: an image over the limit is rejected, one at the limit passes and is marked as a camera image', async () => {
  const mk = (bytes) => setup({ camera: { capture: async () => ({ mimeType: 'image/jpeg', data: b64(bytes) }) } });
  await assert.rejects((await mk(5 * MB + 1)).svc.capturePhoto(), { code: 'FILE_TOO_LARGE' });
  await assert.rejects((await mk(16 * MB)).svc.capturePhoto(), { code: 'FILE_TOO_LARGE_MAX' });
  const ok = await (await mk(5 * MB)).svc.capturePhoto();
  assert.equal(ok.size, 5 * MB);
  assert.equal(ok.source, 'camera');
  setSizeLimitMb(3);
  await assert.rejects((await mk(4 * MB)).svc.capturePhoto(), { code: 'FILE_TOO_LARGE' });
});

/* ---------------- Android adapters (fake plugins) ---------------- */

const streamOf = (chunks, headers = {}) => {
  let i = 0;
  return {
    ok: true, headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), cancel: async () => { i = chunks.length; } }) },
  };
};

test('readLimited streams within the limit, stops keeping data beyond it, and trusts Content-Length without reading', async () => {
  const bytes = (n) => new Uint8Array(n).fill(65);
  const ok = await readLimited('u', 3000, async () => streamOf([bytes(1000), bytes(1000)]));
  assert.equal(ok.size, 2000);
  assert.equal(ok.data, Buffer.alloc(2000, 65).toString('base64'));
  let readCalled = false;
  const declared = await readLimited('u', 3000, async () => ({ ...streamOf([bytes(10)], { 'content-length': '9000' }), body: { getReader: () => ({ read: async () => { readCalled = true; return { done: true }; }, cancel: async () => {} }) } }));
  assert.deepEqual(declared, { tooLarge: true, size: 9000 });
  assert.equal(readCalled, false);
  const streamed = await readLimited('u', 3000, async () => streamOf([bytes(2000), bytes(2000), bytes(500)]));
  assert.deepEqual(streamed, { tooLarge: true, size: 4500 });
  const capped = await readLimited('u', 3000, async () => streamOf(Array.from({ length: 120 }, () => bytes(MB))));
  assert.equal(capped.tooLarge, true);
  assert.equal(capped.atLeast, true);
  const blobFallback = await readLimited('u', 3000, async () => ({ ok: true, headers: { get: () => null }, body: null, blob: async () => new Blob([bytes(100)]) }));
  assert.equal(blobFallback.size, 100);
  await assert.rejects(readLimited('u', 3000, async () => { throw new Error('nope'); }), { code: 'FILE_READ_FAILED' });
  await assert.rejects(readLimited('u', 3000, async () => ({ ok: false })), { code: 'FILE_READ_FAILED' });
});

test('the picker adapter asks the system picker WITHOUT reading data, reports the provider size and reads through the content URL', async () => {
  const calls = [];
  const plugins = { FilePicker: { pickFiles: async (o) => { calls.push(o); return { files: [{ name: 'Scan.PDF', mimeType: 'application/pdf', size: 1234, path: 'content://x/1', webPath: 'http://localhost/_capacitor_content_/x/1' }] }; } } };
  const { picker } = capacitorAdapters(plugins);
  const picked = await picker.pick();
  assert.equal(calls[0].readData, false);
  assert.equal(calls[0].limit, 1);
  assert.deepEqual([picked.name, picked.size], ['Scan.PDF', 1234]);
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (u) => { urls.push(u); return streamOf([new Uint8Array(1234).fill(65)]); };
  try {
    const res = await picked.read({ maxBytes: 5 * MB });
    assert.equal(res.size, 1234);
    assert.deepEqual(urls, ['http://localhost/_capacitor_content_/x/1']);
  } finally { globalThis.fetch = original; }
  // missing size metadata = unknown (0), cancelled picker = null
  const noSize = capacitorAdapters({ FilePicker: { pickFiles: async () => ({ files: [{ name: 'a.pdf', mimeType: 'application/pdf', webPath: 'u' }] }) } });
  assert.equal((await noSize.picker.pick()).size, 0);
  const cancelled = capacitorAdapters({ FilePicker: { pickFiles: async () => { throw new Error('pickFiles canceled.'); } } });
  assert.equal(await cancelled.picker.pick(), null);
});

test('the camera adapter checks the real file size before keeping the image and always removes the temporary file', async () => {
  const deleted = [];
  const original = { fetch: globalThis.fetch, cap: globalThis.Capacitor };
  globalThis.Capacitor = { convertFileSrc: (u) => u };
  const plugins = {
    Camera: { takePhoto: async () => ({ webPath: 'http://localhost/tmp.jpg', uri: 'file:///cache/tmp.jpg' }) },
    Filesystem: { deleteFile: async (o) => { deleted.push(o.path); } },
  };
  const { camera } = capacitorAdapters(plugins);
  try {
    globalThis.fetch = async () => new Response(new Uint8Array(6 * MB).fill(65)); // 6 MB > 5 MB limit
    await assert.rejects(camera.capture(), (e) => e.code === 'FILE_TOO_LARGE' && /^Captured image \(6 MB\)/.test(e.message));
    assert.deepEqual(deleted, ['file:///cache/tmp.jpg'], 'rejected image is cleaned up');
    deleted.length = 0;
    globalThis.fetch = async () => new Response(new Uint8Array(2 * MB).fill(65));
    const shot = await camera.capture();
    assert.equal(byteLengthOfBase64(shot.data), 2 * MB);
    assert.deepEqual(deleted, ['file:///cache/tmp.jpg'], 'accepted image is removed from the camera cache too');
    // a user who backs out leaves nothing behind
    deleted.length = 0;
    const cancelled = capacitorAdapters({ Camera: { takePhoto: async () => { throw Object.assign(new Error('User cancelled photos app'), { code: 'OS-PLUG-CAMR-0006' }); } }, Filesystem: plugins.Filesystem }).camera;
    assert.equal(await cancelled.capture(), null);
  } finally { globalThis.fetch = original.fetch; globalThis.Capacitor = original.cap; }
});

/* ---------------- browser-preview repository ---------------- */

test('the preview repository applies the same limit to picked files, captures and imports', async () => {
  const mock = createMockService();
  assert.ok(await mock.pickFile());
  globalThis.__mydocsPreviewBytes = 7 * MB;
  await assert.rejects(mock.pickFile(), { code: 'FILE_TOO_LARGE' });
  setSizeLimitMb(8);
  globalThis.__mydocsPreviewBytes = 7 * MB;
  const big = await mock.pickFile();
  assert.ok(byteLengthOfBase64(big.data) >= 7 * MB);
  await assert.rejects(mock.importFile(1, { name: 'a.pdf', size: 1, data: b64(9 * MB) }, 'x'), { code: 'FILE_TOO_LARGE' });
  setSizeLimitMb(5);
  globalThis.__mydocsPreviewBytes = 6 * MB;
  await assert.rejects(mock.capturePhoto(), (e) => e.code === 'FILE_TOO_LARGE' && /^Captured image/.test(e.message));
});

/* ---------------- Hindi ---------------- */

test('size messages are translated, keep the numbers, and English stays unchanged', () => {
  const samples = [
    checkSize(7 * MB, { limitMb: 5 }), checkSize(5_000_001, { kind: 'capture', limitMb: 5 }),
    checkSize(20 * MB, { limitMb: 15 }), checkSize(20 * MB, { kind: 'capture' }), checkSize(NaN),
  ];
  for (const s of samples) assert.equal(errorText({ message: s.message }), s.message, 'English is shown as is');
  setLanguage('hi');
  const fileMsg = errorText({ message: samples[0].message });
  assert.match(fileMsg, /[ऀ-ॿ]/);
  assert.ok(fileMsg.includes('7 MB') && fileMsg.includes('5 MB'), fileMsg);
  const shot = errorText({ message: samples[1].message });
  assert.ok(shot.includes('5.01 MB') && shot.includes('5 MB'), shot);
  const max = errorText({ message: samples[2].message });
  assert.ok(max.includes('20 MB') && max.includes('15 MB'), max);
  for (const s of samples) assert.match(errorText({ message: s.message }), /[ऀ-ॿ]/, s.code);
  assert.match(errorText(new DocumentError('FILE_READ_FAILED', 'The selected file could not be read. Please try again or choose another file.')), /[ऀ-ॿ]/);
});

/* ---------------- wiring ---------------- */

test('app wiring: the saved limit is loaded at start, changes apply immediately, and no screen has its own size rule', () => {
  const app = read('www/js/app.js');
  assert.match(app, /setSizeLimitMb\(loadSizeLimitMb\(\)\)/);
  assert.match(app, /function setDocumentSizeLimit\(value\) \{\s*if \(Number\(value\) > BASIC_LIMITS\.maxSizeMb[^\n]*\n\s*const mb = setSizeLimitMb\(value\);\s*saveSizeLimitMb\(mb\);/);
  assert.doesNotMatch(app, /MAX_FILE_BYTES|1048576|\* 1024/);
  const docs = read('www/js/documents.js');
  assert.doesNotMatch(docs, /MAX_FILE_BYTES|25 \* 1024/);
  assert.match(docs, /readData: false/); // the picker no longer loads the whole file up front
  assert.match(read('www/css/styles.css'), /\.settings-select \{/);
});
