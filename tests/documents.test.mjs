// Logic tests run on Node using node:sqlite (real SQLite engine) and an in-memory file store.
// They do NOT cover the Capacitor plugins or Android; see PROJECT_STATUS.md for device verification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase, DEFAULT_CATEGORIES, SCHEMA_VERSION } from '../www/js/database.js';
import { createDocumentService, DocumentError, DOCS_DIR, THUMBS_DIR, DEMO_MESSAGE, suggestName, shareFileName } from '../www/js/documents.js';
import { CATEGORIES } from '../www/js/seed.js';
import { createMockService } from '../www/js/mock.js';
import { writeZip, crc32, base64ToBytes, bytesToBase64, uniqueEntryPaths, sanitizeSegment } from '../www/js/zip.js';
import { createSelection } from '../www/js/selection.js';
import { parseDateQuery, normalizeQuery, escapeLike, matchesDocument } from '../www/js/search.js';

function nodeDriver(file = ':memory:') {
  const sqlite = new DatabaseSync(file);
  return {
    sqlite,
    open: async () => {},
    exec: async (sql) => { sqlite.exec(sql); },
    run: async (sql, params = []) => { sqlite.prepare(sql).run(...params); },
    all: async (sql, params = []) => sqlite.prepare(sql).all(...params),
    begin: async () => sqlite.exec('BEGIN'),
    commit: async () => sqlite.exec('COMMIT'),
    rollback: async () => sqlite.exec('ROLLBACK'),
    close: async () => sqlite.close(),
  };
}

function memStorage() {
  const files = new Map();
  return {
    files, failWrite: false, failRemove: false,
    async write(p, d) { if (this.failWrite) throw new Error('disk full'); files.set(p, d); },
    async remove(p) { if (this.failRemove) throw new Error('permission denied'); files.delete(p); },
    async exists(p) { return files.has(p); },
    async list(dir) { return [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)); },
    async uri(p) { return `file:///private/${p}`; },
    shareFile: null,
    async readBase64(p) { if (!this.files.has(p)) throw new Error('File does not exist'); return this.files.get(p); },
    async beginShareFile(name) { this.shareFile = { name, chunks: [] }; },
    async appendShareFile(name, b64) { if (this.failAppend) throw new Error('ENOSPC: No space left on device'); this.shareFile.chunks.push(b64); },
    async shareFileUri(name) { return `file:///cache/share/${name}`; },
    staged: [],
    async clearShareCache() { this.staged = []; this.shareFile = null; },
    async stageForShare(p, name) { this.staged = [{ from: p, name }]; return `file:///cache/share/${name}`; },
    async src(p) { return `https://localhost/_capacitor_file_/private/${p}`; },
  };
}

async function setup(opts = {}) {
  const driver = nodeDriver();
  const db = createDatabase(driver);
  await db.init();
  const storage = memStorage();
  const opened = [];
  const svc = createDocumentService({ db, storage, viewer: { open: async (u) => opened.push(u) }, ...opts });
  return { db, driver, storage, svc, opened };
}
const real = async (svc, cat) => (await svc.list(cat)).filter((d) => !d.isDemo);
const pdf = (name = 'a.pdf', extra = {}) => ({ name, mimeType: 'application/pdf', size: 100, data: 'QUJD', ...extra });

test('database init sets schema version and default categories', async () => {
  const { driver, svc } = await setup();
  assert.equal(driver.sqlite.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  assert.deepEqual((await svc.listCategories()).map((c) => c.name), DEFAULT_CATEGORIES);
});

test('init is idempotent: no duplicate categories on relaunch', async () => {
  const driver = nodeDriver();
  await createDatabase(driver).init();
  await createDatabase(driver).init();
  assert.equal(driver.sqlite.prepare('SELECT COUNT(*) c FROM categories').get().c, 12);
  assert.equal(driver.sqlite.prepare('SELECT COUNT(*) c FROM documents').get().c, 58);
});

test('rejects a database from a newer schema', async () => {
  const driver = nodeDriver();
  driver.sqlite.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  await assert.rejects(createDatabase(driver).init(), /newer/);
});

test('import, list, filter by category, empty category', async () => {
  const { svc } = await setup();
  const doc = await svc.importFile(1, pdf('Lease.pdf'));
  assert.equal(doc.name, 'Lease');
  assert.equal(doc.mimeType, 'application/pdf');
  assert.equal((await real(svc, 1)).length, 1);
  assert.equal((await real(svc, 2)).length, 0);
  assert.equal((await real(svc)).length, 1);
});

test('duplicate filenames get distinct stored files', async () => {
  const { svc, storage } = await setup();
  const a = await svc.importFile(1, pdf('same.pdf'));
  const b = await svc.importFile(1, pdf('same.pdf'));
  assert.notEqual(a.filePath, b.filePath);
  assert.ok(a.filePath.startsWith(`${DOCS_DIR}/`));
  assert.equal(storage.files.size, 2);
});

test('rejects unsupported type, bad category, empty/oversize file, bad name', async () => {
  const { svc, storage } = await setup();
  await assert.rejects(svc.importFile(1, pdf('x.exe')), { code: 'UNSUPPORTED_TYPE' });
  await assert.rejects(svc.importFile(1, pdf('noext')), { code: 'UNSUPPORTED_TYPE' });
  await assert.rejects(svc.importFile(99, pdf()), { code: 'INVALID_CATEGORY' });
  await assert.rejects(svc.importFile(1, pdf('a.pdf', { data: '' })), { code: 'EMPTY_FILE' });
  await assert.rejects(svc.importFile(1, pdf('a.pdf', { size: 26 * 1024 * 1024 })), { code: 'TOO_LARGE' });
  await assert.rejects(svc.importFile(1, pdf(), '   '), { code: 'INVALID_NAME' });
  assert.equal(storage.files.size, 0);
});

test('failed file write leaves no DB record', async () => {
  const { svc, storage } = await setup();
  storage.failWrite = true;
  await assert.rejects(svc.importFile(1, pdf()), /disk full/);
  assert.equal((await real(svc)).length, 0);
});

test('failed DB insert removes the copied file', async () => {
  const { svc, storage, driver } = await setup();
  driver.sqlite.exec('DROP TABLE documents');
  await assert.rejects(svc.importFile(1, pdf()));
  assert.equal(storage.files.size, 0);
});

test('rename updates metadata only', async () => {
  const { svc, storage } = await setup();
  const doc = await svc.importFile(1, pdf());
  const before = [...storage.files.entries()];
  const renamed = await svc.rename(doc.id, '  New   name ');
  assert.equal(renamed.name, 'New name');
  assert.deepEqual([...storage.files.entries()], before);
  await assert.rejects(svc.rename(doc.id, ''), { code: 'INVALID_NAME' });
  await assert.rejects(svc.rename(999, 'x'), { code: 'NOT_FOUND' });
});

test('delete removes row and file; file failure keeps the record', async () => {
  const { svc, storage } = await setup();
  const a = await svc.importFile(1, pdf());
  storage.failRemove = true;
  await assert.rejects(svc.remove(a.id), /permission denied/);
  assert.equal((await real(svc)).length, 1);
  storage.failRemove = false;
  await svc.remove(a.id);
  assert.equal((await real(svc)).length, 0);
  assert.equal(storage.files.size, 0);
  await assert.rejects(svc.remove(a.id), { code: 'NOT_FOUND' });
});

test('missing file is flagged, open fails cleanly, delete still works', async () => {
  const { svc, storage } = await setup();
  const doc = await svc.importFile(1, pdf());
  storage.files.clear();
  assert.equal((await real(svc, 1))[0].missing, true);
  await assert.rejects(svc.open(doc.id), { code: 'FILE_MISSING' });
  await svc.remove(doc.id);
  assert.equal((await real(svc)).length, 0);
});

test('open passes the private file URI to the viewer', async () => {
  const { svc, opened } = await setup();
  const doc = await svc.importFile(1, pdf());
  await svc.open(doc.id);
  assert.deepEqual(opened, [`file:///private/${doc.filePath}`]);
});

test('reconcile removes orphan files and reports missing ones', async () => {
  const { svc, storage } = await setup();
  const keep = await svc.importFile(1, pdf());
  const gone = await svc.importFile(1, pdf('b.pdf'));
  storage.files.set(`${DOCS_DIR}/orphan.pdf`, 'x');
  storage.files.delete(gone.filePath);
  const result = await svc.reconcile();
  assert.equal(result.orphansRemoved, 1);
  assert.deepEqual(result.missing, [gone.id]);
  assert.ok(storage.files.has(keep.filePath));
});

test('foreign keys are enforced and queries are parameterised', async () => {
  const { svc, db } = await setup();
  await assert.rejects(db.run(`INSERT INTO documents (category_id,name,original_filename,file_type,file_path,file_size,created_at,updated_at)
    VALUES (999,'x','x','pdf','p',1,'t','t');`));
  const doc = await svc.importFile(1, pdf(), `x'); DROP TABLE documents;--`);
  assert.equal((await svc.get(doc.id)).name, `x'); DROP TABLE documents;--`);
});

test('DocumentError carries a code', () => {
  assert.equal(new DocumentError('X', 'm').code, 'X');
});

const V1_SCHEMA = `
  CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
  CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    name TEXT NOT NULL, original_filename TEXT NOT NULL, file_type TEXT NOT NULL, mime_type TEXT, file_path TEXT NOT NULL UNIQUE,
    file_size INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expiry_date TEXT);
  INSERT INTO categories (name) VALUES ('Personal Documents'),('Educational Documents'),('IDs'),('Work Related Documents');
  INSERT INTO documents (category_id,name,original_filename,file_type,mime_type,file_path,file_size,created_at,updated_at)
    VALUES (3,'My real ID scan','id.pdf','pdf','application/pdf','documents/real.pdf',10,'t','t');
  PRAGMA user_version = 1;`;

test('12 categories in the required order with slugs, icons and sort order', async () => {
  const { svc } = await setup();
  const cats = await svc.listCategories();
  assert.deepEqual(cats.map((c) => c.name), [
    'Personal Documents', 'Educational Documents', 'Identity Documents', 'Work & Career', 'Financial Documents', 'Medical & Health',
    'Insurance Documents', 'Property & Real Estate', 'Vehicle Documents', 'Bills & Receipts', 'Legal Documents', 'Travel Documents']);
  assert.deepEqual(cats.map((c) => c.slug), CATEGORIES.map((c) => c.slug));
  assert.ok(cats.every((c) => c.icon && /^[a-z]+(-[a-z]+)*$/.test(c.slug)));
});

test('every category has its exact demo documents, marked demo, in its own category only', async () => {
  const { svc } = await setup();
  const cats = await svc.listCategories();
  for (const spec of CATEGORIES) {
    const cat = cats.find((c) => c.slug === spec.slug);
    const docs = await svc.list(cat.id);
    assert.deepEqual(docs.map((d) => d.name).sort(), [...spec.docs].sort(), spec.slug);
    assert.ok(docs.every((d) => d.isDemo && d.filePath === null && d.fileSize === null && !d.missing && d.categoryId === cat.id));
    assert.ok(docs.every((d) => d.originalFilename === `${d.name}.pdf`));
  }
  assert.equal((await svc.list()).length, 58);
});

test('relaunch does not duplicate demo data and deleted demo docs stay deleted', async () => {
  const driver = nodeDriver();
  const db1 = createDatabase(driver);
  await db1.init();
  const svc = createDocumentService({ db: db1, storage: memStorage() });
  await svc.remove((await svc.list())[0].id);
  const db2 = createDatabase(driver);
  await db2.init();
  assert.equal((await createDocumentService({ db: db2, storage: memStorage() }).list()).length, 57);
});

test('upgrade from schema v1 keeps real documents and renames/adopts categories', async () => {
  const driver = nodeDriver();
  driver.sqlite.exec(V1_SCHEMA);
  const db = createDatabase(driver);
  await db.init();
  const svc = createDocumentService({ db, storage: memStorage() });
  const cats = await svc.listCategories();
  assert.equal(cats.length, 12);
  assert.equal(cats[2].id, 3); // "IDs" row adopted as Identity Documents
  assert.equal(cats[2].name, 'Identity Documents');
  const realDocs = await real(svc, 3);
  assert.equal(realDocs.length, 1);
  assert.equal(realDocs[0].name, 'My real ID scan');
  assert.equal(realDocs[0].isDemo, false);
});

test('demo documents do not open, can be renamed/removed, and are ignored by reconcile', async () => {
  const { svc, opened } = await setup();
  const [demo] = await svc.list(1);
  await assert.rejects(svc.open(demo.id), { code: 'DEMO_DOCUMENT', message: DEMO_MESSAGE });
  assert.deepEqual(opened, []);
  assert.equal((await svc.rename(demo.id, 'Renamed sample')).name, 'Renamed sample');
  assert.deepEqual(await svc.reconcile(), { orphansRemoved: 0, missing: [] });
  await svc.remove(demo.id);
  assert.equal((await svc.list(1)).length, 3);
});

test('real documents must have a file path (constraint)', async () => {
  const { db } = await setup();
  await assert.rejects(db.run(`INSERT INTO documents (category_id,name,original_filename,file_type,created_at,updated_at)
    VALUES (1,'x','x.pdf','pdf','t','t');`));
});

test('an empty category shows no documents after its demo docs are removed', async () => {
  const { svc } = await setup();
  for (const d of await svc.list(12)) await svc.remove(d.id);
  assert.deepEqual(await svc.list(12), []);
});

test('mock repository mirrors the seed data and rejects opening samples', async () => {
  const mock = createMockService();
  const cats = await mock.listCategories();
  assert.equal(cats.length, 12);
  for (const spec of CATEGORIES) {
    const docs = await mock.list(cats.find((c) => c.slug === spec.slug).id);
    assert.equal(docs.length, spec.docs.length);
  }
  await assert.rejects(mock.open(1), { code: 'DEMO_DOCUMENT' });
});

test('suggestName strips the extension, tidies whitespace and caps length', () => {
  assert.equal(suggestName('Aadhaar  Card.PDF'), 'Aadhaar Card');
  assert.equal(suggestName('scan.final.v2.jpeg'), 'scan.final.v2');
  assert.equal(suggestName('noext'), 'noext');
  assert.equal(suggestName(`${'x'.repeat(200)}.pdf`).length, 120);
  assert.equal(suggestName(undefined), '');
});

test('upload with a custom name: name and original filename stored separately, content and extension kept', async () => {
  const { svc, storage } = await setup();
  const file = { name: 'IMG_2041.PNG', mimeType: 'image/png', size: 1234, data: 'SEVMTE8=' };
  const doc = await svc.importFile(3, file, '  My Aadhaar   Card ');
  assert.equal(doc.name, 'My Aadhaar Card');
  assert.equal(doc.originalFilename, 'IMG_2041.PNG');
  assert.equal(doc.fileType, 'png');
  assert.ok(doc.filePath.endsWith('.png'));
  assert.equal(storage.files.get(doc.filePath), 'SEVMTE8='); // content untouched
  assert.equal(doc.categoryId, 3);
  assert.equal((await real(svc, 3)).length, 1); // exactly one record, in the right category
  assert.equal((await real(svc, 1)).length, 0);
  const reopened = await real(svc, 3); // "reopen the category"
  assert.equal(reopened[0].name, 'My Aadhaar Card');
});

test('upload and rename reject empty / whitespace names', async () => {
  const { svc, storage } = await setup();
  await assert.rejects(svc.importFile(1, pdf(), ''), { code: 'INVALID_NAME' });
  await assert.rejects(svc.importFile(1, pdf(), ' 	 '), { code: 'INVALID_NAME' });
  assert.equal(storage.files.size, 0);
  const doc = await svc.importFile(1, pdf(), 'Ok');
  await assert.rejects(svc.rename(doc.id, '   '), { code: 'INVALID_NAME' });
  assert.equal((await svc.get(doc.id)).name, 'Ok');
});

test('pickFile returns null on cancel and the file otherwise', async () => {
  const f = pdf();
  const mk = (r) => setup({ picker: { pick: async () => r } });
  assert.equal(await (await mk(null)).svc.pickFile(), null);
  assert.deepEqual(await (await mk(f)).svc.pickFile(), f);
  await assert.rejects(setup().then((x) => x.svc.pickFile()), { code: 'NO_PICKER' });
});

const jpeg = (extra = {}) => ({ name: 'Captured_20261016_101500.jpg', mimeType: 'image/jpeg', size: 3000, data: 'SU1H', ...extra });

test('capturePhoto: null on cancel, file-like result with generated name otherwise, errors propagate', async () => {
  const mk = (camera, now) => setup({ camera, now });
  assert.equal(await (await mk({ capture: async () => null })).svc.capturePhoto(), null);
  const { svc } = await mk({ capture: async () => ({ mimeType: 'image/jpeg', data: 'QUJDRA==' }) }, () => '2026-10-16T10:15:00');
  const shot = await svc.capturePhoto();
  assert.match(shot.name, /^Captured_20261016_101500\.jpg$/);
  assert.equal(shot.size, 4); // 'QUJDRA==' decodes to 4 bytes
  const denied = await mk({ capture: async () => { throw new DocumentError('CAMERA_DENIED', 'no'); } });
  await assert.rejects(denied.svc.capturePhoto(), { code: 'CAMERA_DENIED' });
  await assert.rejects(setup().then((x) => x.svc.capturePhoto()), { code: 'NO_CAMERA' });
});

test('captured image is saved in the chosen category with thumbnail, separate name and original filename', async () => {
  const thumbnailer = async (data, mime) => { assert.equal(mime, 'image/jpeg'); return 'VEhVTUI='; };
  const { svc, storage } = await setup({ thumbnailer });
  const doc = await svc.importFile(7, jpeg(), 'Aadhaar Card Front');
  assert.equal(doc.categoryId, 7);
  assert.equal(doc.name, 'Aadhaar Card Front');
  assert.equal(doc.originalFilename, 'Captured_20261016_101500.jpg');
  assert.equal(doc.fileType, 'jpg');
  assert.equal(doc.mimeType, 'image/jpeg');
  assert.ok(doc.thumbPath.startsWith(`${THUMBS_DIR}/`));
  assert.equal(storage.files.get(doc.filePath), 'SU1H');
  assert.equal(storage.files.get(doc.thumbPath), 'VEhVTUI=');
  assert.equal((await real(svc, 7)).length, 1);
  assert.equal(await svc.thumbnailSrc(doc), `https://localhost/_capacitor_file_/private/${doc.thumbPath}`);
  assert.equal(await svc.imageSrc(doc.id), `https://localhost/_capacitor_file_/private/${doc.filePath}`);
});

test('thumbnail failure never blocks saving; PDFs get no thumbnail', async () => {
  const bad = await setup({ thumbnailer: async () => { throw new Error('decode failed'); } });
  const doc = await bad.svc.importFile(1, jpeg(), 'Photo');
  assert.equal(doc.thumbPath, null);
  assert.equal(await bad.svc.thumbnailSrc(doc), null);
  const ok = await setup({ thumbnailer: async () => 'VA==' });
  assert.equal((await ok.svc.importFile(1, pdf(), 'Doc')).thumbPath, null);
});

test('delete removes image and thumbnail; failed insert removes both; rename leaves both untouched', async () => {
  const { svc, storage, driver } = await setup({ thumbnailer: async () => 'VA==' });
  const doc = await svc.importFile(1, jpeg(), 'Photo');
  const before = [...storage.files.entries()];
  await svc.rename(doc.id, 'Renamed photo');
  assert.deepEqual([...storage.files.entries()], before);
  await svc.remove(doc.id);
  assert.equal(storage.files.size, 0);
  driver.sqlite.exec('DROP TABLE documents');
  await assert.rejects(svc.importFile(1, jpeg(), 'x'));
  assert.equal(storage.files.size, 0);
});

test('reconcile sweeps orphan thumbnails but keeps referenced ones', async () => {
  const { svc, storage } = await setup({ thumbnailer: async () => 'VA==' });
  const doc = await svc.importFile(1, jpeg(), 'Photo');
  storage.files.set(`${THUMBS_DIR}/orphan.jpg`, 'x');
  await svc.reconcile();
  assert.ok(storage.files.has(doc.thumbPath));
  assert.ok(!storage.files.has(`${THUMBS_DIR}/orphan.jpg`));
});

test('imageSrc rejects demo, non-image and missing documents', async () => {
  const { svc, storage } = await setup();
  const [demo] = await svc.list(1);
  await assert.rejects(svc.imageSrc(demo.id), { code: 'DEMO_DOCUMENT' });
  const p = await svc.importFile(1, pdf(), 'A pdf');
  await assert.rejects(svc.imageSrc(p.id), { code: 'NOT_IMAGE' });
  const img = await svc.importFile(1, jpeg(), 'Img');
  storage.files.delete(img.filePath);
  await assert.rejects(svc.imageSrc(img.id), { code: 'FILE_MISSING' });
});

test('v2 database upgrades to v3 with thumb_path and keeps data', async () => {
  const driver = nodeDriver();
  await createDatabase(driver).init();
  driver.sqlite.exec('ALTER TABLE documents DROP COLUMN thumb_path; PRAGMA user_version = 2;');
  const db = createDatabase(driver);
  await db.init();
  assert.equal(driver.sqlite.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(driver.sqlite.prepare('SELECT COUNT(*) c FROM documents').get().c, 58);
  assert.ok(driver.sqlite.prepare('PRAGMA table_info(documents)').all().some((c) => c.name === 'thumb_path'));
});

test('shareFileName builds a safe, meaningful file name with the real extension', () => {
  assert.equal(shareFileName('My Aadhaar Card', 'pdf'), 'My_Aadhaar_Card.pdf');
  assert.equal(shareFileName('a/b\\c:d*e?f"g<h>i|j', 'jpg'), 'a_b_c_d_e_f_g_h_i_j.jpg');
  assert.equal(shareFileName('  ..hidden..  ', 'png'), 'hidden.png');
  assert.equal(shareFileName('???', 'pdf'), 'document.pdf');
  assert.equal(shareFileName('x'.repeat(200), 'pdf').length, 84);
});

test('shareDocument shares a staged copy named after the document and leaves the original untouched', async () => {
  const shared = [];
  const { svc, storage } = await setup({ sharer: { share: async (a) => { shared.push(a); return true; } } });
  const doc = await svc.importFile(2, pdf('scan.pdf'), 'Degree Certificate');
  const before = [...storage.files.entries()];
  assert.equal(await svc.shareDocument(doc.id), true);
  assert.deepEqual(shared, [{ uri: 'file:///cache/share/Degree_Certificate.pdf', title: 'Degree Certificate' }]);
  assert.deepEqual(storage.staged, [{ from: doc.filePath, name: 'Degree_Certificate.pdf' }]);
  assert.deepEqual([...storage.files.entries()], before);
  assert.equal((await svc.get(doc.id)).name, 'Degree Certificate');
  // a second share replaces the single staged copy instead of piling up duplicates
  const img = await svc.importFile(2, jpeg(), 'Receipt Photo');
  await svc.shareDocument(img.id);
  assert.equal(storage.staged.length, 1);
  assert.equal(storage.staged[0].name, 'Receipt_Photo.jpg');
});

test('shareDocument reports cancel, missing files, demo docs, no sharer and failures', async () => {
  const cancelled = await setup({ sharer: { share: async () => false } });
  const d1 = await cancelled.svc.importFile(1, pdf(), 'A');
  assert.equal(await cancelled.svc.shareDocument(d1.id), false);

  const { svc, storage } = await setup({ sharer: { share: async () => true } });
  const doc = await svc.importFile(1, pdf(), 'B');
  storage.files.delete(doc.filePath);
  await assert.rejects(svc.shareDocument(doc.id), { code: 'FILE_MISSING' });
  const [demo] = await svc.list(1);
  await assert.rejects(svc.shareDocument(demo.id), { code: 'DEMO_DOCUMENT' });
  await assert.rejects(svc.shareDocument(9999), { code: 'NOT_FOUND' });

  const none = await setup();
  const d2 = await none.svc.importFile(1, pdf(), 'C');
  await assert.rejects(none.svc.shareDocument(d2.id), { code: 'NO_SHARE' });

  const failing = await setup({ sharer: { share: async () => { throw new DocumentError('NO_SHARE_TARGET', 'No app'); } } });
  const d3 = await failing.svc.importFile(1, pdf(), 'D');
  await assert.rejects(failing.svc.shareDocument(d3.id), { code: 'NO_SHARE_TARGET' });

  const brokenStage = await setup({ sharer: { share: async () => true } });
  brokenStage.storage.stageForShare = async () => { throw new Error('disk full'); };
  const d4 = await brokenStage.svc.importFile(1, pdf(), 'E');
  await assert.rejects(brokenStage.svc.shareDocument(d4.id), { code: 'SHARE_FAILED' });
});

test('reconcile clears the temporary share copy', async () => {
  const { svc, storage } = await setup({ sharer: { share: async () => true } });
  const doc = await svc.importFile(1, pdf(), 'F');
  await svc.shareDocument(doc.id);
  assert.equal(storage.staged.length, 1);
  await svc.reconcile();
  assert.equal(storage.staged.length, 0);
});

test('parseDateQuery understands common numeric and textual date formats', () => {
  const cases = {
    '2026-10-17': '2026-10-17%', '2026/10/17': '2026-10-17%', '17/10/2026': '2026-10-17%', '17-10-2026': '2026-10-17%',
    '17.10.2026': '2026-10-17%', '7/3/2026': '2026-03-07%', '10/17/2026': '2026-10-17%', // mm/dd only when dd/mm is impossible
    '2026-10': '2026-10-%', '10/2026': '2026-10-%', '2026': '2026-%',
    '17/10': '%-10-17T%', '10/17': '%-10-17T%',
    '17 Oct 2026': '2026-10-17%', '17 october 2026': '2026-10-17%', 'Oct 17, 2026': '2026-10-17%', 'sept 2026': '2026-09-%', 'October 2026': '2026-10-%',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(parseDateQuery(input), expected, input);
  for (const bad of ['31/02/2026', '2026-13-01', '99/99', '1850', 'aadhaar', '17 foo 2026', '', '   ']) assert.equal(parseDateQuery(bad), null, bad);
  assert.equal(normalizeQuery('  a   b  '), 'a b');
  assert.equal(escapeLike('50%_x\\'), '50\\%\\_x\\\\');
});

test('search: partial, case-insensitive, trimmed, across all categories, ranked by prefix', async () => {
  const { svc } = await setup();
  assert.deepEqual((await svc.search('  AADHAAR ')).map((d) => d.name), ['Aadhaar Card']);
  assert.deepEqual((await svc.search('marksheet')).map((d) => [d.name, d.categoryName]), [['Semester Marksheet', 'Educational Documents']]);
  const pass = await svc.search('pass');
  assert.deepEqual(pass.map((d) => d.name), ['Passport']);
  const ins = (await svc.search('insurance')).map((d) => d.name);
  assert.equal(ins[0], 'Insurance Claim Form'); // names starting with the query first
  assert.ok(ins.includes('Health Insurance Policy') && ins.includes('Travel Insurance') && ins.includes('Vehicle Insurance'));
  const cats = new Set((await svc.search('insurance')).map((d) => d.categoryName));
  assert.ok(cats.size >= 3, 'results span several categories');
  assert.deepEqual(await svc.search(''), []);
  assert.deepEqual(await svc.search('   '), []);
  assert.deepEqual(await svc.search('zzzz-no-match'), []);
});

test('search: identical names are separate results with their own id, category and date', async () => {
  const { svc } = await setup();
  const bills = await svc.search('electricity bill');
  assert.equal(bills.length, 2);
  assert.notEqual(bills[0].id, bills[1].id);
  assert.deepEqual(bills.map((d) => d.categoryName).sort(), ['Bills & Receipts', 'Property & Real Estate']);
  const real1 = await svc.importFile(1, pdf(), 'Electricity Bill');
  const again = await svc.search('electricity bill');
  assert.equal(again.length, 3);
  assert.ok(again.some((d) => d.id === real1.id && d.categoryName === 'Personal Documents'));
});

test('search by date: formats, partial dates, created date of real documents and expiry date', async () => {
  const { svc, db } = await setup({ now: () => '2026-10-17T07:01:02.000Z' });
  const doc = await svc.importFile(3, pdf('scan.pdf'), 'Zebra Pass');
  for (const q of ['2026-10-17', '17/10/2026', '17-10-2026', '17.10.2026', '10/17/2026', '17 Oct 2026', 'Oct 17, 2026', '2026-10', 'October 2026', '17/10']) {
    assert.ok((await svc.search(q)).some((d) => d.id === doc.id), q);
  }
  for (const q of ['18/10/2026', '2026-11', '16/10']) assert.ok(!(await svc.search(q)).some((d) => d.id === doc.id), q);
  // demo documents are searchable by their stored date too (Aadhaar Card: 2026-03-11)
  assert.ok((await svc.search('11/03/2026')).some((d) => d.name === 'Aadhaar Card'));
  // expiry date is also searched
  await db.run('UPDATE documents SET expiry_date = ? WHERE id = ?', ['2031-05-20', doc.id]);
  assert.ok((await svc.search('20/05/2031')).some((d) => d.id === doc.id));
});

test('search treats % and _ literally and cannot be used for SQL injection', async () => {
  const { svc } = await setup();
  const a = await svc.importFile(1, pdf(), '100% done');
  await svc.importFile(1, pdf('b.pdf'), 'snake_case');
  assert.deepEqual((await svc.search('%')).map((d) => d.id), [a.id]);
  assert.deepEqual((await svc.search('e_c')).map((d) => d.name), ['snake_case']);
  assert.deepEqual(await svc.search("'; DROP TABLE documents; --"), []);
  assert.equal((await svc.list()).length, 60);
});

test('search also matches the original file name', async () => {
  const { svc } = await setup();
  await svc.importFile(2, pdf('IMG_2041.pdf'), 'Receipt');
  assert.deepEqual((await svc.search('img_2041')).map((d) => d.name), ['Receipt']);
});

test('search reflects renames and deletions immediately (database is the single source of truth)', async () => {
  const { svc } = await setup();
  const doc = await svc.importFile(1, pdf(), 'Quokka');
  assert.equal((await svc.search('quokka')).length, 1);
  await svc.rename(doc.id, 'Wombat');
  assert.equal((await svc.search('quokka')).length, 0);
  assert.equal((await svc.search('wombat')).length, 1);
  await svc.remove(doc.id);
  assert.equal((await svc.search('wombat')).length, 0);
});

test('in-memory preview search matches the SQLite search', async () => {
  const { svc } = await setup();
  const mock = createMockService();
  for (const q of ['aadhaar', 'BILL', 'pass', 'insurance', '2026-03', '13/03/2026', '17 Mar 2026', 'zzz', '%']) {
    assert.deepEqual((await mock.search(q)).map((d) => d.name), (await svc.search(q)).map((d) => d.name), q);
  }
  assert.equal(matchesDocument({ name: 'X', createdAt: '2026-10-17T00:00:00Z' }, '17/10/2026'), true);
});

/* ---------- ZIP + bulk share ---------- */

/** Independent minimal ZIP reader (follows the spec: end record -> central directory -> local headers). */
function readZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  assert.ok(end >= 0, 'end of central directory record');
  const count = v.getUint16(end + 10, true);
  let p = v.getUint32(end + 16, true);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50);
    const method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true), size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    assert.equal(v.getUint32(off, true), 0x04034b50);
    const lNameLen = v.getUint16(off + 26, true), lExtra = v.getUint16(off + 28, true);
    const start = off + 30 + lNameLen + lExtra;
    out.push({ name, method, crc, size, data: bytes.subarray(start, start + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
const zipBytes = (chunks) => base64ToBytes(bytesToBase64(Uint8Array.from(chunks.flatMap((c) => [...base64ToBytes(c)]))));
const b64 = (text) => bytesToBase64(new TextEncoder().encode(text));

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('writeZip produces a valid archive: names, sizes, CRCs and contents (incl. empty file, unicode, large chunked file)', async () => {
  const big = new Uint8Array(300000).map((_, i) => (i * 31) & 255);
  const files = { 'A/one.txt': b64('hello'), 'A/empty.txt': '', 'B/Zażółć.txt': b64('unicode'), 'B/big.bin': bytesToBase64(big) };
  const chunks = [];
  const progress = [];
  const res = await writeZip({
    entries: Object.entries(files).map(([path, data]) => ({ path, read: async () => data })),
    append: async (c) => { chunks.push(c); }, chunkChars: 1024, onProgress: (d, t) => progress.push([d, t]),
  });
  assert.equal(res.count, 4);
  const zip = readZip(zipBytes(chunks));
  assert.deepEqual(zip.map((e) => e.name), Object.keys(files));
  for (const e of zip) {
    assert.equal(e.method, 0);
    assert.deepEqual([...e.data], [...base64ToBytes(files[e.name])], e.name);
    assert.equal(e.size, base64ToBytes(files[e.name]).length);
    assert.equal(e.crc, crc32(e.data));
  }
  assert.equal(res.bytes, zipBytes(chunks).length);
  assert.deepEqual(progress.at(-1), [4, 4]);
  await assert.rejects(writeZip({ entries: [], append: async () => {} }), /at least one/);
});

test('entry names: duplicates are renamed (never dropped), illegal characters and path traversal are neutralised', () => {
  const paths = uniqueEntryPaths([
    { category: 'Educational Documents', name: 'Certificate', ext: 'pdf' },
    { category: 'Identity Documents', name: 'Certificate', ext: 'pdf' },
    { category: 'Identity Documents', name: 'Certificate', ext: 'pdf' },
    { category: 'Identity Documents', name: 'certificate', ext: 'PDF' }, // case-insensitive clash
    { category: '../../etc', name: '../passwd', ext: 'txt' },
    { category: 'C:\\Windows', name: 'a/b\\c:d*e?"f<g>h|i', ext: 'jpg' },
    { category: '', name: '..', ext: '' },
  ]);
  assert.deepEqual(paths.slice(0, 4), ['Educational Documents/Certificate.pdf', 'Identity Documents/Certificate.pdf', 'Identity Documents/Certificate (2).pdf', 'Identity Documents/certificate (3).PDF']);
  assert.equal(new Set(paths.map((p) => p.toLowerCase())).size, paths.length);
  for (const p of paths) {
    assert.ok(!p.startsWith('/') && !p.includes('\\') && !p.split('/').some((seg) => seg === '..' || seg === '.' || seg === ''), p);
    assert.equal(p.split('/').length, 2, p);
  }
  assert.equal(sanitizeSegment('  ...  '), 'document');
});

test('selection: by unique id, same names stay separate, indeterminate category state, prune on delete', async () => {
  const { svc } = await setup();
  const bills = await svc.search('electricity bill'); // two documents with the same name
  const sel = createSelection();
  sel.toggle(bills[0].id);
  assert.equal(sel.has(bills[0].id), true);
  assert.equal(sel.has(bills[1].id), false);
  assert.equal(sel.size, 1);
  const ids = [1, 2, 3];
  assert.equal(sel.stateOf(ids), 'none');
  sel.toggle(1); assert.equal(sel.stateOf(ids), 'some');
  sel.setMany(ids, true); assert.equal(sel.stateOf(ids), 'all');
  sel.setMany(ids, false); assert.equal(sel.stateOf(ids), 'none');
  assert.equal(sel.has(bills[0].id), true); // other categories untouched by the group operation
  assert.equal(sel.prune([bills[1].id]), 1);
  assert.equal(sel.size, 0);
  sel.toggle(5); sel.clear(); assert.equal(sel.size, 0);
  assert.equal(sel.stateOf([]), 'none');
});

function zipSetup(extra = {}) {
  const shared = [];
  return setup({ now: () => '2026-10-17T10:00:00', sharer: { share: async (a) => { shared.push(a); return true; } }, ...extra }).then((x) => ({ ...x, shared }));
}

test('shareSelectedAsZip: one ZIP with exactly the selected documents, category folders, duplicates kept, originals untouched', async () => {
  const { svc, storage, shared } = await zipSetup();
  const a = await svc.importFile(2, { name: 'x.pdf', size: 5, data: b64('AAAAA') }, 'Certificate');
  const b = await svc.importFile(3, { name: 'y.pdf', size: 5, data: b64('BBBBB') }, 'Certificate');
  const c = await svc.importFile(3, { name: 'z.pdf', size: 5, data: b64('CCCCC') }, 'Certificate');
  const skipped = await svc.importFile(1, { name: 'n.pdf', size: 5, data: b64('NNNNN') }, 'Not selected');
  const before = [...storage.files.entries()];
  const seen = [];
  const res = await svc.shareSelectedAsZip([c.id, a.id, b.id, a.id], { onProgress: (d, t, p) => seen.push([d, t]) });
  assert.deepEqual(res, { shared: true, fileName: 'MyDocs_2026-10-17.zip', count: 3 });
  assert.equal(shared.length, 1);
  assert.deepEqual(shared[0], { uri: 'file:///cache/share/MyDocs_2026-10-17.zip', title: 'MyDocs_2026-10-17' });
  const zip = readZip(zipBytes(storage.shareFile.chunks));
  assert.deepEqual(zip.map((e) => e.name), ['Educational Documents/Certificate.pdf', 'Identity Documents/Certificate.pdf', 'Identity Documents/Certificate (2).pdf']);
  assert.deepEqual(zip.map((e) => new TextDecoder().decode(e.data)), ['AAAAA', 'BBBBB', 'CCCCC']);
  assert.ok(!zip.some((e) => new TextDecoder().decode(e.data) === 'NNNNN')); // unselected document is not included
  assert.deepEqual([...storage.files.entries()], before); // library untouched
  assert.ok(seen.length >= 3 && seen.at(-1)[0] === 3);
  assert.equal((await real(svc)).length, 4);
  assert.ok(skipped.id);
});

test('shareSelectedAsZip: validation and all-or-nothing failures', async () => {
  const { svc, storage, shared } = await zipSetup();
  await assert.rejects(svc.shareSelectedAsZip([]), { code: 'NOTHING_SELECTED' });
  await assert.rejects(svc.shareSelectedAsZip(undefined), { code: 'NOTHING_SELECTED' });
  const ok = await svc.importFile(1, pdf(), 'Good');
  const gone = await svc.importFile(1, pdf('g.pdf'), 'Gone');
  const [demo] = await svc.list(1);
  await assert.rejects(svc.shareSelectedAsZip([ok.id, 999999]), { code: 'SELECTION_STALE' });
  storage.files.delete(gone.filePath);
  const e1 = await svc.shareSelectedAsZip([ok.id, gone.id, demo.id]).catch((e) => e);
  assert.equal(e1.code, 'ZIP_UNAVAILABLE');
  assert.deepEqual(e1.names.sort(), [demo.name, 'Gone'].sort());
  assert.match(e1.message, /Nothing was shared/);
  assert.equal(shared.length, 0); // nothing shared, no partial archive
  storage.failAppend = true;
  await assert.rejects(svc.shareSelectedAsZip([ok.id]), { code: 'ZIP_NO_SPACE' });
  assert.equal(storage.shareFile, null); // half-written archive cleaned up
  storage.failAppend = false;
  assert.equal((await svc.shareSelectedAsZip([ok.id])).shared, true); // retry after an error works
  const none = await setup();
  await assert.rejects(none.svc.shareSelectedAsZip([1]), { code: 'NO_SHARE' });
});

test('shareSelectedAsZip reports a dismissed share sheet and replaces the previous temporary archive', async () => {
  const { svc, storage } = await zipSetup({ sharer: { share: async () => false } });
  const d = await svc.importFile(1, pdf(), 'Doc');
  assert.equal((await svc.shareSelectedAsZip([d.id])).shared, false);
  const first = storage.shareFile;
  await svc.shareSelectedAsZip([d.id]);
  assert.notEqual(storage.shareFile, first);
});

/* ---------- navigation menu data ---------- */
import { MENU_ITEMS, buildSettingsSections } from '../www/js/menu.js';

test('menu items: unique ids, label + icon on every entry, Settings present', () => {
  assert.ok(MENU_ITEMS.length >= 1);
  assert.equal(new Set(MENU_ITEMS.map((m) => m.id)).size, MENU_ITEMS.length);
  for (const m of MENU_ITEMS) assert.ok(m.id && m.label && m.icon, JSON.stringify(m));
  assert.ok(MENU_ITEMS.some((m) => m.id === 'settings' && m.label === 'Settings'));
});

test('settings sections: structured rows, version formatting with and without build info', () => {
  const secs = buildSettingsSections({ version: '1.2.3', build: '45' });
  assert.ok(secs.length >= 1);
  for (const s of secs) { assert.ok(s.id && s.title && Array.isArray(s.rows)); for (const r of s.rows) assert.ok(r.id && r.label); }
  const version = (x) => x.flatMap((s) => s.rows).find((r) => r.id === 'version').value;
  assert.equal(version(secs), '1.2.3 (45)');
  assert.equal(version(buildSettingsSections({ version: '2.0' })), '2.0');
  assert.equal(version(buildSettingsSections()), 'Unknown');
});

/* ---------- themes ---------- */
import { readFileSync } from 'node:fs';
import { THEME_KEY, THEME_OPTIONS, normalizeTheme, loadTheme, saveTheme, applyTheme } from '../www/js/theme.js';

const memoryStore = (initial = {}) => {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m };
};

test('theme preference: light by default, persists dark, ignores junk, survives unavailable storage', () => {
  assert.equal(normalizeTheme('dark'), 'dark');
  for (const junk of [undefined, null, '', 'DARK', 'blue', 5]) assert.equal(normalizeTheme(junk), 'light');
  const store = memoryStore();
  assert.equal(loadTheme(store), 'light'); // nothing saved yet
  assert.equal(saveTheme('dark', store), true);
  assert.equal(store.m.get(THEME_KEY), 'dark');
  assert.equal(loadTheme(store), 'dark'); // "restart": a fresh read sees the saved choice
  saveTheme('light', store);
  assert.equal(loadTheme(store), 'light');
  assert.equal(loadTheme(memoryStore({ [THEME_KEY]: 'garbage' })), 'light');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(loadTheme(broken), 'light');
  assert.equal(saveTheme('dark', broken), false);
  assert.deepEqual(THEME_OPTIONS.map((o) => o.id), ['light', 'dark']);
  assert.equal(THEME_OPTIONS[0].description, 'A clean and bright appearance');
  assert.equal(THEME_OPTIONS[1].description, 'Easy on the eyes in low-light environments');
});

test('applyTheme sets data-theme immediately, updates theme-color and the Android status-bar style', () => {
  const attrs = {};
  const meta = { v: '', setAttribute(k, v) { this.v = v; } };
  const root = { setAttribute: (k, v) => { attrs[k] = v; }, classList: { add() {}, remove() {} }, ownerDocument: { querySelector: () => meta } };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => ' #1c3557 ' });
  const styles = [];
  const bars = { setStyle: (o) => { styles.push(o.style); return Promise.resolve(); } };
  assert.equal(applyTheme('dark', { root, systemBars: bars }), 'dark');
  assert.equal(attrs['data-theme'], 'dark');
  assert.equal(meta.v, '#1c3557');
  assert.equal(applyTheme('whatever', { root, systemBars: bars }), 'light');
  assert.equal(attrs['data-theme'], 'light');
  assert.deepEqual(styles, ['DARK', 'DEFAULT']);
  delete globalThis.getComputedStyle;
});

const CSS = readFileSync(new URL('../www/css/styles.css', import.meta.url), 'utf8');
const tokens = (selector) => {
  const body = CSS.slice(CSS.indexOf(selector)).match(/\{([^}]*)\}/)[1];
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
};
const light = tokens(':root {');
const dark = { ...light, ...tokens(':root[data-theme="dark"] {') };
const lum = (hex) => {
  if (hex.length === 4) hex = `#${[...hex.slice(1)].map((c) => c + c).join('')}`;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('light theme keeps the original MyDocs colours (baseline guard)', () => {
  assert.equal(light['primary'], '#1f5fbf');
  assert.equal(light['header-bg'], '#1f5fbf');
  assert.equal(light['bg'], '#f4f6fb');
  assert.equal(light['surface'], '#fff');
  assert.equal(light['card'], '#fff');
  assert.equal(light['text'], '#1c1b1f');
  assert.equal(light['primary-container'], '#dbe6fb');
});

test('dark palette follows the specification', () => {
  assert.equal(dark['bg'], '#121212');
  assert.equal(dark['surface'], '#1e1e1e');
  assert.equal(dark['card'], '#252525');
  assert.equal(dark['text'], '#f5f5f5');
  assert.equal(dark['muted'], '#bdbdbd');
  assert.equal(dark['primary'], '#90caf9');
  assert.equal(dark['outline'], '#383838');
});

test('both themes meet WCAG AA contrast (4.5:1) for text, accents, header, buttons, errors and banners', () => {
  const pairs = [
    ['text', 'bg'], ['text', 'surface'], ['text', 'card'], ['muted', 'bg'], ['muted', 'card'], ['muted', 'surface'],
    ['primary', 'bg'], ['primary', 'card'], ['primary', 'surface'], ['primary', 'primary-container'], ['text', 'primary-container'],
    ['on-primary', 'primary'], ['on-header', 'header-bg'], ['error', 'card'], ['error', 'surface'], ['banner-text', 'banner-bg'], ['toast-text', 'toast-bg'],
  ];
  for (const [name, theme] of [['light', light], ['dark', dark]]) {
    for (const [fg, bg] of pairs) {
      const ratio = contrast(theme[fg], theme[bg]);
      assert.ok(ratio >= 4.5, `${name}: ${fg} on ${bg} = ${ratio.toFixed(2)}`);
    }
  }
});

test('theme comes only from the user setting: no prefers-color-scheme override, every theme token is defined for dark', () => {
  assert.ok(!CSS.includes('prefers-color-scheme'));
  const overridden = tokens(':root[data-theme="dark"] {');
  for (const key of Object.keys(light)) {
    if (!['radius'].includes(key)) assert.ok(key in overridden, `dark theme defines --${key}`);
  }
});
