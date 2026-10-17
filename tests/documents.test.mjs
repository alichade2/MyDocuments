// Logic tests run on Node using node:sqlite (real SQLite engine) and an in-memory file store.
// They do NOT cover the Capacitor plugins or Android; see PROJECT_STATUS.md for device verification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase, DEFAULT_CATEGORIES, SCHEMA_VERSION } from '../www/js/database.js';
import { createDocumentService, DocumentError, DOCS_DIR, THUMBS_DIR, DEMO_MESSAGE, suggestName, shareFileName } from '../www/js/documents.js';
import { CATEGORIES } from '../www/js/seed.js';
import { createMockService } from '../www/js/mock.js';

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
    staged: [],
    async clearShareCache() { this.staged = []; },
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
