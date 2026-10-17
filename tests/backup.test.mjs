// Backup creation, archive validation and restore (replace + merge), including failures and tampered archives.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeApp, memScratch, cleanupTemp, pdf, b64, describeApp, nodeDriver } from './helpers/backup-env.mjs';
import {
  BackupError, BACKUP_EXTENSION, MANIFEST_ENTRY, DB_ENTRY, BACKUP_FORMAT_VERSION, backupFileName, parseManifest, sha256Hex, RESTORE_FILE,
} from '../www/js/backup.js';
import { openZip, bytesSource, ZipError, isSafeEntryName } from '../www/js/zipread.js';
import { writeZip, crc32, base64ToBytes, bytesToBase64 } from '../www/js/zip.js';
import { setSizeLimitMb } from '../www/js/sizelimit.js';

after(cleanupTemp);

const sql = (app, text, params = []) => app.driver.sqlite.prepare(text).all(...params);
const cat = (app, slug) => sql(app, 'SELECT id FROM categories WHERE slug = ?', [slug])[0].id;
const bytesOf = (app, path) => new Uint8Array(app.scratch.files.get(path));

/** An app with real documents in several categories (duplicate names, a Hindi name, an empty custom category). */
async function populated(options) {
  const app = await makeApp(options);
  const personal = cat(app, 'personal-documents');
  const edu = cat(app, 'educational-documents');
  const agri = cat(app, 'agricultural-documents');
  await app.docs.importFile(personal, pdf('aadhaar.pdf', 'AADHAAR-DATA'), 'Aadhaar Card');
  await app.docs.importFile(edu, pdf('degree.pdf', 'DEGREE-DATA'), 'Degree Certificate');
  await app.docs.importFile(agri, pdf('land.pdf', 'LAND-DATA'), 'Land Record');
  await app.docs.importFile(agri, pdf('land2.pdf', 'LAND-DATA-2'), 'Land Record'); // same display name twice
  await app.docs.importFile(personal, { name: 'photo.jpg', mimeType: 'image/jpeg', size: 4, data: b64('JPEG') }, 'मेरा आधार कार्ड');
  const pets = await app.docs.createCategory({ name: 'Pet Records', icon: 'pets' });
  await app.docs.createCategory({ name: 'Empty Custom', icon: 'cloud' });
  await app.docs.importFile(pets.id, pdf('vet.pdf', 'VET-DATA'), 'Vet Invoice');
  return app;
}

async function makeBackup(app, opts) {
  const res = await app.backup.createBackup(opts);
  return { ...res, bytes: bytesOf(app, res.path) };
}

/** Puts archive bytes into another app's scratch folder, as if the user had picked the file. */
function deliver(app, bytes) {
  app.scratch.put(RESTORE_FILE, bytes);
  return RESTORE_FILE;
}

/** Rebuilds an archive from entries (so tests can tamper with single parts). */
async function buildZip(entries) {
  const chunks = [];
  await writeZip({ entries: entries.map((e) => ({ path: e.path, read: async () => bytesToBase64(e.bytes) })), append: async (c) => { chunks.push(Buffer.from(c, 'base64')); } });
  return new Uint8Array(Buffer.concat(chunks));
}
async function entriesOf(bytes) {
  const zip = await openZip(bytesSource(bytes));
  const out = [];
  for (const e of zip.list) out.push({ path: e.name, bytes: await zip.read(e) });
  return out;
}
const withEntry = (entries, path, change) => entries.map((e) => (e.path === path ? { ...e, bytes: change(e.bytes) } : e));
const textOf = (bytes) => new TextDecoder().decode(bytes);
const flipOne = (bytes) => { const c = new Uint8Array(bytes); c[Math.floor(c.length / 2)] ^= 0xff; return c; };

/* ---------------- creating a backup ---------------- */

test('file name and extension: MyDocs_Backup_<date>.mydocsbackup', () => {
  assert.equal(BACKUP_EXTENSION, 'mydocsbackup');
  assert.equal(backupFileName(new Date(2026, 9, 17)), 'MyDocs_Backup_2026-10-17.mydocsbackup');
  assert.equal(backupFileName(new Date(2026, 0, 5)), 'MyDocs_Backup_2026-01-05.mydocsbackup');
});

test('a backup is one standard ZIP with manifest.json, database/mydocs.sqlite and every document file', async () => {
  const app = await populated({ now: () => new Date(2026, 9, 17, 10, 30) });
  const backup = await makeBackup(app);
  assert.equal(backup.fileName, 'MyDocs_Backup_2026-10-17.mydocsbackup');
  assert.equal(backup.size, backup.bytes.length);
  const zip = await openZip(bytesSource(backup.bytes));
  const names = zip.list.map((e) => e.name).sort();
  assert.ok(names.includes(MANIFEST_ENTRY) && names.includes(DB_ENTRY));
  assert.equal(names.filter((n) => n.startsWith('documents/')).length, 6); // 6 real files (the sample documents have none)
  assert.deepEqual(names.filter((n) => !n.startsWith('documents/')), [DB_ENTRY, MANIFEST_ENTRY]);
  const manifest = parseManifest(textOf(await zip.read(zip.entries.get(MANIFEST_ENTRY))));
  assert.equal(manifest.format, 'mydocs-backup');
  assert.equal(manifest.formatVersion, BACKUP_FORMAT_VERSION);
  assert.equal(manifest.createdAt, new Date(2026, 9, 17, 10, 30).toISOString());
  assert.equal(manifest.counts.categories, 15); // 13 built-in + 2 custom
  assert.equal(manifest.counts.documents, 58 + 6);
  assert.equal(manifest.counts.files, 6);
  assert.equal(manifest.database.sha256, await sha256Hex(await zip.read(zip.entries.get(DB_ENTRY))));
  // the SQLite entry is a real database file
  assert.equal(textOf((await zip.read(zip.entries.get(DB_ENTRY))).subarray(0, 15)), 'SQLite format 3');
  assert.equal(backup.summary.documents, 64);
  assert.equal(backup.summary.customCategories, 2);
  assert.equal(backup.missingFiles, 0);
});

test('the manifest keeps ids, slugs, names, icons, order, the document -> category mapping, sizes and SHA-256 checksums', async () => {
  const app = await populated();
  const { bytes } = await makeBackup(app);
  const zip = await openZip(bytesSource(bytes));
  const m = parseManifest(textOf(await zip.read(zip.entries.get(MANIFEST_ENTRY))));
  const agri = m.categories.find((c) => c.slug === 'agricultural-documents');
  assert.deepEqual([agri.name, agri.icon, agri.isCustom], ['Agricultural Documents', 'agriculture', false]);
  const pets = m.categories.find((c) => c.name === 'Pet Records');
  assert.deepEqual([pets.isCustom, pets.icon, pets.sortOrder > 1000], [true, 'pets', true]);
  assert.ok(m.categories.find((c) => c.name === 'Empty Custom'), 'empty custom categories are listed');
  const lands = m.documents.filter((d) => d.name === 'Land Record');
  assert.equal(lands.length, 2);
  assert.ok(lands.every((d) => d.categorySlug === 'agricultural-documents' && d.categoryId === agri.id));
  assert.notEqual(lands[0].file.path, lands[1].file.path);
  const hindi = m.documents.find((d) => d.name === 'मेरा आधार कार्ड');
  assert.equal(hindi.originalFilename, 'photo.jpg');
  assert.equal(hindi.fileType, 'jpg');
  for (const d of m.documents.filter((x) => x.file)) {
    const data = await zip.read(zip.entries.get(d.file.path));
    assert.equal(data.length, d.file.size);
    assert.equal(await sha256Hex(data), d.file.sha256);
    assert.match(d.file.path, /^documents\/[0-9a-f-]+\.(pdf|jpg)$/);
  }
  assert.ok(m.documents.filter((d) => d.isDemo).every((d) => d.file === null)); // sample entries have no file
  assert.ok(m.excluded.includes('thumbnails') && m.excluded.includes('Google sign-in tokens') && m.excluded.includes('App Lock state'));
  assert.ok(!JSON.stringify(m).match(/token|password|pin/i) || m.excluded.join().match(/token/i)); // only the "excluded" list mentions secrets
});

test('thumbnails, temporary share files and caches are not part of the backup', async () => {
  const app = await populated({ thumbnailer: async () => b64('THUMB') });
  await app.storage.write('thumbnails/x.jpg', b64('THUMB'));
  await app.storage.write('share/tmp.zip', b64('TMP'));
  const { bytes } = await makeBackup(app);
  const names = (await openZip(bytesSource(bytes))).list.map((e) => e.name);
  assert.ok(!names.some((n) => /thumb|share|cache|log/i.test(n)));
});

test('the database in the archive is a consistent snapshot, also when changes still sit in the WAL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mydocs-wal-'));
  const app = await populated({ file: join(dir, 'live.sqlite'), wal: true });
  assert.equal(sql(app, 'PRAGMA journal_mode')[0].journal_mode, 'wal');
  const before = sql(app, 'SELECT COUNT(*) n FROM documents')[0].n;
  const { bytes } = await makeBackup(app);
  const zip = await openZip(bytesSource(bytes));
  const copy = nodeDriver();
  const handle = await copy.attach(bytesToBase64(await zip.read(zip.entries.get(DB_ENTRY))));
  assert.equal(copy.sqlite.prepare('SELECT COUNT(*) n FROM bk.documents').get().n, before);
  assert.equal(copy.sqlite.prepare('PRAGMA bk.integrity_check').get().integrity_check, 'ok');
  assert.equal(copy.sqlite.prepare('PRAGMA bk.user_version').get().user_version, 5);
  await handle.detach();
  // creating the backup did not change the live database
  assert.equal(sql(app, 'SELECT COUNT(*) n FROM documents')[0].n, before);
});

test('a document whose file is missing is still listed (without a file) and reported', async () => {
  const app = await populated();
  const gone = sql(app, "SELECT id, file_path FROM documents WHERE name = 'Degree Certificate'")[0];
  await app.storage.remove(gone.file_path);
  const backup = await makeBackup(app);
  assert.equal(backup.missingFiles, 1);
  const m = parseManifest(textOf(await (await openZip(bytesSource(backup.bytes))).read((await openZip(bytesSource(backup.bytes))).entries.get(MANIFEST_ENTRY))));
  const doc = m.documents.find((d) => d.id === gone.id);
  assert.equal(doc.file, null);
  assert.equal(m.warnings[0].code, 'FILE_MISSING');
  assert.deepEqual(m.warnings[0].documentIds, [gone.id]);
});

test('creating a backup can be cancelled; nothing is left behind and the data is untouched', async () => {
  const app = await populated();
  let calls = 0;
  await assert.rejects(app.backup.createBackup({ shouldCancel: () => ++calls > 6 }), { code: 'BACKUP_CANCELLED' });
  assert.equal(app.scratch.files.size, 0);
  assert.equal(sql(app, 'SELECT COUNT(*) n FROM documents')[0].n, 64);
});

test('a failure while writing (disk full) removes the half-written file and reports a clear error', async () => {
  const app = await populated();
  app.scratch.append = async () => { throw new Error('ENOSPC'); };
  await assert.rejects(app.backup.createBackup(), (e) => e instanceof BackupError && e.code === 'BACKUP_FAILED');
  assert.equal(app.scratch.files.size, 0);
});

/* ---------------- restore: replace ---------------- */

test('replace restore into an empty app brings back the same categories, documents, ids and files', async () => {
  const source = await populated();
  const original = await describeApp(source);
  const { bytes } = await makeBackup(source);

  const target = await makeApp();
  const path = deliver(target, bytes);
  const info = await target.backup.inspect(path);
  assert.deepEqual([info.categories, info.customCategories, info.documents, info.files], [15, 2, 64, 6]);
  const result = await target.backup.restore(path, { mode: 'replace' });
  assert.equal(result.documents, 64);

  const restored = await describeApp(target);
  assert.deepEqual(restored.categories, original.categories); // ids, slugs, names, icons, order, custom flag
  assert.deepEqual(restored.documents, original.documents); // ids, names, original file names, category, dates, sizes
  assert.deepEqual(restored.files, original.files); // file contents byte for byte
});

test('every document is restored to exactly its original category, duplicate names stay separate', async () => {
  const source = await populated();
  const { bytes } = await makeBackup(source);
  const target = await makeApp();
  await target.backup.restore(deliver(target, bytes), { mode: 'replace' });
  const rows = sql(target, `SELECT d.name, c.name AS category FROM documents d JOIN categories c ON c.id = d.category_id WHERE d.is_demo = 0 ORDER BY d.id`);
  assert.deepEqual(rows.map((r) => [r.name, r.category]), [
    ['Aadhaar Card', 'Personal Documents'], ['Degree Certificate', 'Educational Documents'], ['Land Record', 'Agricultural Documents'],
    ['Land Record', 'Agricultural Documents'], ['मेरा आधार कार्ड', 'Personal Documents'], ['Vet Invoice', 'Pet Records'],
  ]);
  const lands = sql(target, "SELECT file_path FROM documents WHERE name = 'Land Record'");
  assert.equal(new Set(lands.map((l) => l.file_path)).size, 2);
  assert.deepEqual(new Set(await Promise.all(lands.map((l) => target.storage.readBase64(l.file_path)))), new Set([b64('LAND-DATA'), b64('LAND-DATA-2')]));
  assert.equal(sql(target, "SELECT COUNT(*) n FROM documents WHERE category_id = (SELECT id FROM categories WHERE name = 'Empty Custom')")[0].n, 0);
  assert.ok(sql(target, "SELECT id FROM categories WHERE name = 'Empty Custom'").length === 1, 'empty custom categories are restored');
});

test('restoring replaces what was there: old documents and their files are gone, the backup is exactly the result', async () => {
  const source = await populated();
  const { bytes } = await makeBackup(source);
  const target = await makeApp();
  const stale = await target.docs.importFile(cat(target, 'legal-documents'), pdf('old.pdf', 'OLD'), 'Old Affidavit');
  await target.docs.createCategory({ name: 'Old Custom' });
  await target.backup.restore(deliver(target, bytes), { mode: 'replace' });
  assert.equal(sql(target, "SELECT COUNT(*) n FROM documents WHERE name = 'Old Affidavit'")[0].n, 0);
  assert.equal(sql(target, "SELECT COUNT(*) n FROM categories WHERE name = 'Old Custom'")[0].n, 0);
  assert.equal(await target.storage.exists(stale.filePath), false); // orphan file cleaned up after the swap
  assert.deepEqual(await describeApp(target), await describeApp(source));
});

test('restoring twice does not create duplicates (categories, documents or files)', async () => {
  const source = await populated();
  const { bytes } = await makeBackup(source);
  const target = await makeApp();
  await target.backup.restore(deliver(target, bytes), { mode: 'replace' });
  const once = await describeApp(target);
  await target.backup.restore(deliver(target, bytes), { mode: 'replace' });
  assert.deepEqual(await describeApp(target), once);
  assert.equal(sql(target, "SELECT COUNT(*) n FROM categories WHERE slug = 'agricultural-documents'")[0].n, 1);
  assert.equal(target.storage.files.size, 6);
  // the app keeps working: a new document gets a fresh id and a new custom category sorts after the built-in ones
  const added = await target.docs.importFile(cat(target, 'personal-documents'), pdf('n.pdf', 'N'), 'New');
  assert.ok(added.id > Math.max(...once.documents.map((d) => d.id)));
  const custom = await target.docs.createCategory({ name: 'After Restore' });
  assert.ok(custom.sortOrder > 1000);
});

test('restoring on the same device keeps working files and removes nothing that is in the backup', async () => {
  const app = await populated();
  const { bytes } = await makeBackup(app);
  const before = await describeApp(app);
  const extra = await app.docs.importFile(cat(app, 'legal-documents'), pdf('later.pdf', 'LATER'), 'Added After Backup');
  await app.backup.restore(deliver(app, bytes), { mode: 'replace' });
  assert.deepEqual(await describeApp(app), before);
  assert.equal(await app.storage.exists(extra.filePath), false);
});

test('a restored document that had no file shows up as missing instead of breaking the restore', async () => {
  const source = await populated();
  const gone = sql(source, "SELECT file_path FROM documents WHERE name = 'Degree Certificate'")[0].file_path;
  await source.storage.remove(gone);
  const { bytes } = await makeBackup(source);
  const target = await makeApp();
  await target.backup.restore(deliver(target, bytes), { mode: 'replace' });
  const docs = (await target.docs.list()).filter((d) => d.name === 'Degree Certificate');
  assert.equal(docs.length, 1);
  assert.equal(docs[0].missing, true);
});

test('thumbnails are rebuilt for restored images (they are not in the backup)', async () => {
  const source = await populated({ thumbnailer: async () => b64('THUMB') });
  const { bytes } = await makeBackup(source);
  const target = await makeApp({ thumbnailer: async () => b64('THUMB2') });
  await target.backup.restore(deliver(target, bytes), { mode: 'replace' });
  const photo = sql(target, "SELECT thumb_path FROM documents WHERE file_type = 'jpg'")[0];
  assert.match(photo.thumb_path, /^thumbnails\/.+\.jpg$/);
  assert.equal(await target.storage.readBase64(photo.thumb_path), b64('THUMB2'));
});

test('the document size limit is not applied to a restore (saved documents are never judged again)', async () => {
  const source = await populated();
  setSizeLimitMb(3);
  try {
    const { bytes } = await makeBackup(source);
    const target = await makeApp();
    await target.backup.restore(deliver(target, bytes), { mode: 'replace' });
    assert.equal(sql(target, 'SELECT COUNT(*) n FROM documents')[0].n, 64);
  } finally { setSizeLimitMb(5); }
});

/* ---------------- restore: validation, tampering, failures ---------------- */

async function untouched(target) { return JSON.stringify(await describeApp(target)); }

test('anything that is not a MyDocs backup is rejected before the data is touched', async () => {
  const target = await populated();
  const snapshot = await untouched(target);
  const cases = {
    'plain text': new TextEncoder().encode('hello, this is not a zip file at all'),
    'empty file': new Uint8Array(0),
    'zip without manifest': await buildZip([{ path: 'hello.txt', bytes: new TextEncoder().encode('hi') }]),
  };
  for (const [label, bytes] of Object.entries(cases)) {
    const path = deliver(target, bytes);
    await assert.rejects(target.backup.inspect(path), (e) => e.code === 'BACKUP_INVALID', label);
    await assert.rejects(target.backup.restore(path, { mode: 'replace' }), (e) => e.code === 'BACKUP_INVALID', label);
  }
  assert.equal(await untouched(target), snapshot);
});

test('a backup from a newer version stops safely with a compatibility message', async () => {
  const source = await populated();
  const { bytes } = await makeBackup(source);
  const entries = await entriesOf(bytes);
  const newer = withEntry(entries, MANIFEST_ENTRY, (b) => new TextEncoder().encode(textOf(b).replace('"formatVersion": 1', '"formatVersion": 99')));
  const target = await makeApp();
  const path = deliver(target, await buildZip(newer));
  const err = await target.backup.restore(path, { mode: 'replace' }).catch((e) => e);
  assert.equal(err.code, 'BACKUP_UNSUPPORTED');
  assert.match(err.message, /newer version of MyDocs/);
  assert.equal(sql(target, 'SELECT COUNT(*) n FROM documents WHERE is_demo = 0')[0].n, 0);
  // a newer database schema is refused too
  const schemaNewer = withEntry(entries, MANIFEST_ENTRY, (b) => new TextEncoder().encode(textOf(b).replace('"schemaVersion": 5', '"schemaVersion": 6')));
  await assert.rejects(target.backup.inspect(deliver(target, await buildZip(schemaNewer))), { code: 'BACKUP_UNSUPPORTED' });
});

test('damaged archives are detected: flipped bytes, truncation, wrong checksums', async () => {
  const source = await populated();
  const { bytes } = await makeBackup(source);
  const target = await populated();
  const snapshot = await untouched(target);
  const zip = await openZip(bytesSource(bytes));
  const docEntry = zip.list.find((e) => e.name.startsWith('documents/'));

  // 1) a byte inside a document file flipped (ZIP CRC no longer matches)
  const flipped = new Uint8Array(bytes);
  const dataStart = docEntry.localOffset + 30 + new TextEncoder().encode(docEntry.name).length;
  flipped[dataStart] ^= 0xff;
  await assert.rejects(target.backup.restore(deliver(target, flipped), { mode: 'replace' }), (e) => e.code === 'BACKUP_CORRUPT');

  // 2) the archive cut short (the central directory is gone)
  await assert.rejects(target.backup.restore(deliver(target, bytes.subarray(0, bytes.length - 40)), { mode: 'replace' }), (e) => e.code === 'BACKUP_INVALID');
  await assert.rejects(target.backup.inspect(deliver(target, bytes.subarray(0, 100))), (e) => e.code === 'BACKUP_INVALID');

  // 3) a document replaced by different data with a correct ZIP CRC: only the manifest SHA-256 can notice
  const entries = await entriesOf(bytes);
  const forged = withEntry(entries, docEntry.name, (b) => b.map((x) => x ^ 1)); // same length, different content, valid CRC after re-zipping
  const forgedBytes = await buildZip(forged);
  await assert.rejects(target.backup.restore(deliver(target, forgedBytes), { mode: 'replace' }), (e) => e.code === 'BACKUP_CORRUPT');

  // 4) the database entry altered
  const dbForged = await buildZip(withEntry(entries, DB_ENTRY, flipOne));
  await assert.rejects(target.backup.restore(deliver(target, dbForged), { mode: 'replace' }), (e) => ['BACKUP_CORRUPT', 'BACKUP_INVALID'].includes(e.code));

  assert.equal(await untouched(target), snapshot, 'nothing changed after any of these failures');
  assert.equal(target.storage.files.size, 6);
});

test('unsafe archives are refused: path traversal, absolute paths, backslashes, duplicates', async () => {
  const names = ['../evil.txt', '/etc/passwd', 'documents/../../x', 'C:/boot.ini', 'a\\b', 'documents/./x'];
  for (const name of names) assert.equal(isSafeEntryName(name), false, name);
  for (const name of ['manifest.json', 'documents/abc.pdf', 'database/mydocs.sqlite', 'dir/']) assert.equal(isSafeEntryName(name), true, name);
  const source = await populated();
  const entries = await entriesOf((await makeBackup(source)).bytes);
  const target = await makeApp();
  for (const evil of ['../evil.txt', '/abs.txt', 'documents/../../escape']) {
    const bytes = await buildZip([...entries, { path: evil, bytes: new TextEncoder().encode('x') }]);
    await assert.rejects(target.backup.inspect(deliver(target, bytes)), (e) => e.code === 'BACKUP_INVALID', evil);
  }
  const dupes = await buildZip([...entries, { path: 'MANIFEST.json', bytes: new TextEncoder().encode('{}') }]);
  await assert.rejects(target.backup.inspect(deliver(target, dupes)), (e) => e.code === 'BACKUP_INVALID');
  assert.equal(target.storage.files.size, 0);
});

test('a manifest that points outside documents/ or disagrees with the database is rejected', async () => {
  const source = await populated();
  const entries = await entriesOf((await makeBackup(source)).bytes);
  const target = await makeApp();
  const tamper = (fn) => withEntry(entries, MANIFEST_ENTRY, (b) => { const m = JSON.parse(textOf(b)); fn(m); return new TextEncoder().encode(JSON.stringify(m)); });
  const bad = {
    'path outside documents': (m) => { m.documents.find((d) => d.file).file.path = '../../etc/passwd'; },
    'document in a missing category': (m) => { m.documents[0].categoryId = 9999; },
    'category moved in the manifest': (m) => { const d = m.documents.find((x) => x.name === 'Aadhaar Card'); d.categoryId = m.categories.find((c) => c.slug === 'legal-documents').id; },
    'wrong counts': (m) => { m.counts.documents += 1; },
    'file listed twice': (m) => { const files = m.documents.filter((d) => d.file); files[1].file.path = files[0].file.path; },
    'not a sha256': (m) => { m.documents.find((d) => d.file).file.sha256 = 'zzz'; },
  };
  for (const [label, fn] of Object.entries(bad)) {
    await assert.rejects(target.backup.inspect(deliver(target, await buildZip(tamper(fn)))), (e) => e.code === 'BACKUP_INVALID', label);
  }
});

test('if a file cannot be written the restore stops, removes what it already placed and keeps the old data', async () => {
  const source = await populated();
  const { bytes } = await makeBackup(source);
  const target = await makeApp();
  const old = await target.docs.importFile(cat(target, 'legal-documents'), pdf('keep.pdf', 'KEEP'), 'Keep Me');
  const snapshot = await untouched(target);
  target.storage.failWriteAfter = target.storage.writes + 3; // the 4th file write fails
  const err = await target.backup.restore(deliver(target, bytes), { mode: 'replace' }).catch((e) => e);
  assert.equal(err.code, 'RESTORE_FAILED');
  assert.match(err.message, /existing data has been kept unchanged/);
  target.storage.failWriteAfter = Infinity;
  assert.equal(await untouched(target), snapshot);
  assert.deepEqual([...target.storage.files.keys()], [old.filePath], 'files placed before the failure were removed again');
});

test('if the database step fails nothing is changed: the transaction rolls back and the new files are removed', async () => {
  const source = await populated();
  const { bytes } = await makeBackup(source);
  const target = await makeApp();
  await target.docs.importFile(cat(target, 'legal-documents'), pdf('keep.pdf', 'KEEP'), 'Keep Me');
  const snapshot = await untouched(target);
  const originalRun = target.driver.run;
  target.driver.run = async (text, params) => { if (/^\s*INSERT INTO documents/.test(text)) throw new Error('constraint failed'); return originalRun(text, params); };
  const err = await target.backup.restore(deliver(target, bytes), { mode: 'replace' }).catch((e) => e);
  assert.equal(err.code, 'RESTORE_FAILED');
  assert.match(String(err.cause ?? ''), /^$/); // the original database error is not shown to the user
  assert.equal(await untouched(target), snapshot);
  assert.equal(target.storage.files.size, 1);
});

test('restoring when there is not enough free storage is refused up front', async () => {
  const source = await populated();
  const { bytes } = await makeBackup(source);
  const target = await makeApp({ freeSpace: async () => 10 });
  const err = await target.backup.restore(deliver(target, bytes), { mode: 'replace' }).catch((e) => e);
  assert.equal(err.code, 'BACKUP_STORAGE');
  assert.equal(target.storage.files.size, 0);
  assert.equal(sql(target, 'SELECT COUNT(*) n FROM documents WHERE is_demo = 0')[0].n, 0);
});

test('a backup made by an older app version (older schema, fewer columns) can still be restored', async () => {
  // build an old-style backup by hand: schema v3 (no is_custom column, no custom ordering)
  const old = nodeDriver();
  old.sqlite.exec(`
    CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, slug TEXT, icon TEXT, sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL REFERENCES categories(id), name TEXT NOT NULL, original_filename TEXT NOT NULL,
      file_type TEXT NOT NULL, mime_type TEXT, file_path TEXT UNIQUE, file_size INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expiry_date TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0, seed_key TEXT UNIQUE, thumb_path TEXT);
    INSERT INTO categories (id, name, created_at, slug, icon, sort_order) VALUES (1, 'Personal Documents', 't', 'personal-documents', 'person', 1), (2, 'Pet Records', 't', 'custom-old-uuid', 'pets', 13);
    INSERT INTO documents (id, category_id, name, original_filename, file_type, mime_type, file_path, file_size, created_at, updated_at) VALUES
      (7, 1, 'Passport', 'passport.pdf', 'pdf', 'application/pdf', 'documents/aaaa-1111.pdf', 8, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      (8, 2, 'Vet Card', 'vet.pdf', 'pdf', 'application/pdf', 'documents/bbbb-2222.pdf', 3, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
    PRAGMA user_version = 3;`);
  const snap = await old.snapshot();
  const files = { 'documents/aaaa-1111.pdf': 'PASSPORT', 'documents/bbbb-2222.pdf': 'VET' };
  const entries = [{ path: DB_ENTRY, bytes: base64ToBytes(snap.data) }];
  const docs = [{ id: 7, cat: 1, slug: 'personal-documents', name: 'Passport', file: 'documents/aaaa-1111.pdf', fn: 'passport.pdf' }, { id: 8, cat: 2, slug: 'custom-old-uuid', name: 'Vet Card', file: 'documents/bbbb-2222.pdf', fn: 'vet.pdf' }];
  const fileMeta = {};
  for (const d of docs) { const bytes = new TextEncoder().encode(files[d.file]); entries.push({ path: d.file, bytes }); fileMeta[d.file] = { path: d.file, size: bytes.length, sha256: await sha256Hex(bytes) }; }
  const manifest = {
    format: 'mydocs-backup', formatVersion: 1, schemaVersion: 3, createdAt: '2026-02-01T00:00:00.000Z', counts: { categories: 2, documents: 2, files: 2 },
    database: { path: DB_ENTRY, size: base64ToBytes(snap.data).length, sha256: await sha256Hex(base64ToBytes(snap.data)) },
    categories: [{ id: 1, slug: 'personal-documents', name: 'Personal Documents', icon: 'person', sortOrder: 1, isCustom: false }, { id: 2, slug: 'custom-old-uuid', name: 'Pet Records', icon: 'pets', sortOrder: 13, isCustom: false }],
    documents: docs.map((d) => ({ id: d.id, categoryId: d.cat, categorySlug: d.slug, name: d.name, originalFilename: d.fn, fileType: 'pdf', createdAt: 't', isDemo: false, file: fileMeta[d.file] })),
  };
  entries.push({ path: MANIFEST_ENTRY, bytes: new TextEncoder().encode(JSON.stringify(manifest)) });
  const target = await makeApp();
  const path = deliver(target, await buildZip(entries));
  await target.backup.restore(path, { mode: 'replace' });
  const cats = sql(target, 'SELECT slug, name, is_custom, sort_order FROM categories ORDER BY id');
  assert.ok(cats.some((c) => c.slug === 'personal-documents' && c.is_custom === 0));
  assert.ok(cats.some((c) => c.slug === 'agricultural-documents'), 'built-in categories the old backup did not know are added');
  const doc = sql(target, "SELECT d.name, c.name AS cat FROM documents d JOIN categories c ON c.id = d.category_id WHERE d.name IN ('Passport','Vet Card') ORDER BY d.id");
  assert.deepEqual(doc.map((d) => [d.name, d.cat]), [['Passport', 'Personal Documents'], ['Vet Card', 'Pet Records']]);
  assert.equal(await target.storage.readBase64('documents/aaaa-1111.pdf'), b64('PASSPORT'));
});

/* ---------------- restore: merge ---------------- */

test('merge adds what is missing, matches categories, never overwrites and never duplicates', async () => {
  const source = await populated();
  const { bytes } = await makeBackup(source);

  const target = await makeApp();
  const mine = await target.docs.importFile(cat(target, 'personal-documents'), pdf('mine.pdf', 'MINE'), 'My Own Document');
  const sameName = await target.docs.createCategory({ name: 'Pet Records', icon: 'cloud' }); // same name as a backup category
  const result = await target.backup.restore(deliver(target, bytes), { mode: 'merge' });
  assert.equal(result.addedDocuments, 6);

  assert.equal(sql(target, "SELECT COUNT(*) n FROM documents WHERE name = 'My Own Document'")[0].n, 1); // untouched
  assert.equal(await target.storage.readBase64(mine.filePath), b64('MINE'));
  assert.equal(sql(target, "SELECT COUNT(*) n FROM categories WHERE name = 'Pet Records' COLLATE NOCASE")[0].n, 1, 'same-named categories are combined');
  const pets = sql(target, "SELECT d.name, d.category_id FROM documents d WHERE d.name = 'Vet Invoice'")[0];
  assert.equal(pets.category_id, sameName.id);
  assert.ok(sql(target, "SELECT id FROM categories WHERE name = 'Empty Custom'").length === 1, 'empty custom categories come along');
  assert.deepEqual(sql(target, "SELECT c.name FROM documents d JOIN categories c ON c.id = d.category_id WHERE d.name = 'Land Record'").map((r) => r.name), ['Agricultural Documents', 'Agricultural Documents']);
  assert.equal(sql(target, 'SELECT COUNT(*) n FROM categories WHERE slug IS NOT NULL AND slug = ?', ['agricultural-documents'])[0].n, 1);

  // merging the same backup again changes nothing
  const before = await describeApp(target);
  const again = await target.backup.restore(deliver(target, bytes), { mode: 'merge' });
  assert.equal(again.addedDocuments, 0);
  assert.equal(again.addedCategories, 0);
  assert.deepEqual(await describeApp(target), before);
});

test('merge into the app the backup came from keeps everything as it is', async () => {
  const app = await populated();
  const { bytes } = await makeBackup(app);
  const before = await describeApp(app);
  const r = await app.backup.restore(deliver(app, bytes), { mode: 'merge' });
  assert.equal(r.addedDocuments, 0);
  assert.deepEqual(await describeApp(app), before);
});

test('a failed merge changes nothing either', async () => {
  const source = await populated();
  const { bytes } = await makeBackup(source);
  const target = await makeApp();
  await target.docs.importFile(cat(target, 'personal-documents'), pdf('mine.pdf', 'MINE'), 'My Own Document');
  const snapshot = await untouched(target);
  target.storage.failWriteAfter = target.storage.writes + 2;
  await assert.rejects(target.backup.restore(deliver(target, bytes), { mode: 'merge' }), { code: 'RESTORE_FAILED' });
  target.storage.failWriteAfter = Infinity;
  assert.equal(await untouched(target), snapshot);
  await assert.rejects(target.backup.restore(deliver(target, bytes), { mode: 'sideways' }), { code: 'RESTORE_FAILED' });
});

/* ---------------- the ZIP reader ---------------- */

test('zip reader: STORE and DEFLATE entries, CRC checks, sizes and limits', async () => {
  const text = 'hello hello hello hello hello hello';
  const deflated = deflateRawSync(Buffer.from(text));
  // hand-built archive with one DEFLATE entry (as another tool would write it)
  const name = Buffer.from('docs/a.txt');
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8); local.writeUInt32LE(crc32(Buffer.from(text)), 14);
  local.writeUInt32LE(deflated.length, 18); local.writeUInt32LE(text.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc32(Buffer.from(text)), 16); central.writeUInt32LE(deflated.length, 20); central.writeUInt32LE(text.length, 24); central.writeUInt16LE(name.length, 28);
  const body = Buffer.concat([local, name, deflated]);
  const cd = Buffer.concat([central, name]);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(body.length, 16);
  const zip = await openZip(bytesSource(new Uint8Array(Buffer.concat([body, cd, end]))));
  assert.equal(textOf(await zip.read(zip.entries.get('docs/a.txt'))), text);
  // wrong CRC is detected
  const broken = Buffer.concat([body, cd, end]); broken.writeUInt32LE(0x12345678, body.length + 16);
  const z2 = await openZip(bytesSource(new Uint8Array(broken)));
  await assert.rejects(z2.read(z2.entries.get('docs/a.txt')), (e) => e instanceof ZipError && e.code === 'ZIP_CORRUPT');
  // limits: an entry that claims to be enormous is refused when the archive is opened
  const bomb = Buffer.concat([body, cd, end]); bomb.writeUInt32LE(0x7fffffff, body.length + 24);
  await assert.rejects(openZip(bytesSource(new Uint8Array(bomb))), (e) => e.code === 'ZIP_INVALID');
  // encrypted entries are refused
  const enc = Buffer.concat([body, cd, end]); enc.writeUInt16LE(1, body.length + 8);
  await assert.rejects(openZip(bytesSource(new Uint8Array(enc))), (e) => e.code === 'ZIP_UNSUPPORTED');
  await assert.rejects(openZip(bytesSource(new Uint8Array(10))), (e) => e.code === 'ZIP_INVALID');
});
