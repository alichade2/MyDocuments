// Logic tests run on Node using node:sqlite (real SQLite engine) and an in-memory file store.
// They do NOT cover the Capacitor plugins or Android; see PROJECT_STATUS.md for device verification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase, DEFAULT_CATEGORIES, SCHEMA_VERSION } from '../www/js/database.js';
import { createDocumentService, DocumentError, DOCS_DIR } from '../www/js/documents.js';

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
  assert.equal(driver.sqlite.prepare('SELECT COUNT(*) c FROM categories').get().c, 4);
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
  assert.equal((await svc.list(1)).length, 1);
  assert.equal((await svc.list(2)).length, 0);
  assert.equal((await svc.list()).length, 1);
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
  assert.equal((await svc.list()).length, 0);
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
  assert.equal((await svc.list()).length, 1);
  storage.failRemove = false;
  await svc.remove(a.id);
  assert.equal((await svc.list()).length, 0);
  assert.equal(storage.files.size, 0);
  await assert.rejects(svc.remove(a.id), { code: 'NOT_FOUND' });
});

test('missing file is flagged, open fails cleanly, delete still works', async () => {
  const { svc, storage } = await setup();
  const doc = await svc.importFile(1, pdf());
  storage.files.clear();
  assert.equal((await svc.list(1))[0].missing, true);
  await assert.rejects(svc.open(doc.id), { code: 'FILE_MISSING' });
  await svc.remove(doc.id);
  assert.equal((await svc.list()).length, 0);
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
