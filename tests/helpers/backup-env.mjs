// Shared test environment for backup / restore: a real SQLite engine (node:sqlite) with the same snapshot / attach
// behaviour as the Android driver, an in-memory document store and an in-memory scratch (cache) folder.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../../www/js/database.js';
import { createDocumentService } from '../../www/js/documents.js';
import { createBackupService } from '../../www/js/backup.js';

const tmp = mkdtempSync(join(tmpdir(), 'mydocs-test-'));
let counter = 0;
export const cleanupTemp = () => rmSync(tmp, { recursive: true, force: true });

export function nodeDriver({ file = ':memory:', wal = false } = {}) {
  const sqlite = new DatabaseSync(file);
  if (wal) sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
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
    async snapshot() {
      const f = join(tmp, `snap-${++counter}.sqlite`);
      sqlite.exec(`VACUUM INTO '${f}'`);
      const buf = readFileSync(f);
      unlinkSync(f);
      return { data: buf.toString('base64'), size: buf.length };
    },
    async attach(base64) {
      const f = join(tmp, `att-${++counter}.sqlite`);
      writeFileSync(f, Buffer.from(base64, 'base64'));
      sqlite.exec(`ATTACH DATABASE '${f}' AS bk`);
      return { detach: async () => { sqlite.exec('DETACH DATABASE bk'); unlinkSync(f); } };
    },
  };
}

export function memStorage() {
  const files = new Map();
  return {
    files, failWriteAfter: Infinity, writes: 0,
    async write(p, d) { if (++this.writes > this.failWriteAfter) throw new Error('disk full'); files.set(p, d); },
    async remove(p) { files.delete(p); },
    async exists(p) { return files.has(p); },
    async list(dir) { return [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)); },
    async readBase64(p) { if (!files.has(p)) throw new Error('File does not exist'); return files.get(p); },
    async uri(p) { return `file:///private/${p}`; },
    async src(p) { return p; },
  };
}

export function memScratch() {
  const files = new Map();
  return {
    files,
    async write(p, b64) { files.set(p, Buffer.from(b64, 'base64')); },
    async append(p, b64) { files.set(p, Buffer.concat([files.get(p) ?? Buffer.alloc(0), Buffer.from(b64, 'base64')])); },
    async size(p) { if (!files.has(p)) throw new Error('File does not exist'); return files.get(p).length; },
    async read(p, offset, length) { const f = files.get(p); if (!f) throw new Error('File does not exist'); return new Uint8Array(f.subarray(offset, offset + length)); },
    async remove(p) { files.delete(p); },
    async exists(p) { return files.has(p); },
    put(p, bytes) { files.set(p, Buffer.from(bytes)); },
  };
}

/** A complete app instance: database, documents, backup service. */
export async function makeApp({ file, wal, now, freeSpace, thumbnailer } = {}) {
  const driver = nodeDriver({ file, wal });
  const db = createDatabase(driver);
  await db.init();
  const storage = memStorage();
  const scratch = memScratch();
  const docs = createDocumentService({ db, storage, thumbnailer });
  const backup = createBackupService({
    db, storage, scratch, now, freeSpace,
    afterRestore: async () => { await docs.reconcile(); await docs.rebuildThumbnails(); },
  });
  return { driver, db, storage, scratch, docs, backup };
}

export const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
export const pdf = (name, text = name) => ({ name, mimeType: 'application/pdf', size: text.length, data: b64(text) });

/** Everything that matters for "the same data": categories, documents (with their category slug) and file contents. */
export async function describeApp({ db, storage }) {
  const categories = await db.all('SELECT id, slug, name, icon, sort_order, is_custom FROM categories ORDER BY id;');
  const documents = await db.all(
    `SELECT d.id, d.name, d.original_filename, d.file_type, d.file_path, d.file_size, d.created_at, d.is_demo, c.slug AS category_slug, c.name AS category_name
       FROM documents d JOIN categories c ON c.id = d.category_id ORDER BY d.id;`);
  const files = {};
  for (const d of documents) if (d.file_path && await storage.exists(d.file_path)) files[d.file_path] = await storage.readBase64(d.file_path);
  return { categories, documents, files };
}
