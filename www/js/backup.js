// Backup and restore. A backup is ONE ZIP file (extension .mydocsbackup) that contains
//   manifest.json            what is inside (format version, counts, category/document mapping, sizes, SHA-256 checksums)
//   database/mydocs.sqlite   a consistent snapshot of the whole SQLite database (VACUUM INTO, so the WAL is included)
//   documents/<file>         every stored document file, exactly as it is stored
// Not included: thumbnails (rebuilt after a restore), temporary share files, caches, logs, App Lock state, Google tokens,
// preferences of this device (theme, language, size limit). ZIP is not encryption: the file holds readable copies of the documents.
//
// Restoring never trusts the archive: structure, manifest, checksums and the database are validated first; the database
// change is ONE transaction, files that were put in place are removed again if anything fails, and the old data stays
// untouched until everything has been verified.
import { writeZip, base64ToBytes, bytesToBase64 } from './zip.js';
import { openZip, ZipError } from './zipread.js';
import { SCHEMA_VERSION } from './database.js';
import { CUSTOM_ORDER_BASE } from './seed.js';

export const BACKUP_EXTENSION = 'mydocsbackup';
export const BACKUP_FORMAT = 'mydocs-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const MANIFEST_ENTRY = 'manifest.json';
export const DB_ENTRY = 'database/mydocs.sqlite';
export const BACKUP_DIR = 'backup'; // scratch (cache) folder for the archive being built
export const RESTORE_FILE = 'restore/incoming.mydocsbackup'; // scratch copy of the archive being restored
const DOC_PATH = /^documents\/[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SQLITE_MAGIC = 'SQLite format 3\u0000';

export class BackupError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'BackupError'; this.code = code; Object.assign(this, details); }
}

const MSG = {
  invalid: 'This file is not a valid MyDocs backup.',
  corrupt: 'The backup is damaged or incomplete, so it was not restored. Your current data has not been changed.',
  failed: 'The backup could not be created. Please try again.',
  restoreFailed: 'The restore failed. Your existing data has been kept unchanged.',
  cancelled: 'The operation was cancelled.',
  noDatabase: 'The backup does not contain a readable database.',
};

export const sha256Hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** MyDocs_Backup_2026-10-17.mydocsbackup (local date). */
export function backupFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `MyDocs_Backup_${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}.${BACKUP_EXTENSION}`;
}

function wrapZipError(err) {
  if (err instanceof BackupError) return err;
  if (err instanceof ZipError) {
    if (err.code === 'ZIP_CORRUPT') return new BackupError('BACKUP_CORRUPT', MSG.corrupt);
    return new BackupError('BACKUP_INVALID', MSG.invalid);
  }
  return err;
}

/* ---------------- manifest ---------------- */

const isInt = (v) => Number.isInteger(v) && v >= 0;
const isText = (v, max = 2000) => typeof v === 'string' && v.length <= max;

/** Validates the manifest of an archive and returns it. Throws BackupError (BACKUP_INVALID / BACKUP_UNSUPPORTED). */
export function parseManifest(text) {
  let m;
  try { m = JSON.parse(text); } catch { throw new BackupError('BACKUP_INVALID', MSG.invalid); }
  const bad = () => new BackupError('BACKUP_INVALID', MSG.invalid);
  if (!m || typeof m !== 'object' || m.format !== BACKUP_FORMAT) throw bad();
  if (!isInt(m.formatVersion) || m.formatVersion < 1) throw bad();
  if (m.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupError('BACKUP_UNSUPPORTED', `This backup was created by a newer version of MyDocs (backup format ${m.formatVersion}). Please update MyDocs and try again.`, { version: m.formatVersion });
  }
  if (!isInt(m.schemaVersion) || m.schemaVersion < 1 || Number.isNaN(Date.parse(m.createdAt))) throw bad();
  if (m.schemaVersion > SCHEMA_VERSION) {
    throw new BackupError('BACKUP_UNSUPPORTED', `This backup was created by a newer version of MyDocs (backup format ${m.schemaVersion}). Please update MyDocs and try again.`, { version: m.schemaVersion });
  }
  const db = m.database;
  if (!db || db.path !== DB_ENTRY || !isInt(db.size) || !HEX64.test(db.sha256)) throw bad();
  if (!Array.isArray(m.categories) || !Array.isArray(m.documents)) throw bad();
  if (m.counts?.categories !== m.categories.length || m.counts?.documents !== m.documents.length) throw bad();
  const catIds = new Set();
  for (const c of m.categories) {
    if (!isInt(c?.id) || !isText(c.name, 200) || !c.name || catIds.has(c.id)) throw bad();
    if (!(c.slug === null || isText(c.slug, 200)) || !(c.icon === null || isText(c.icon, 100))) throw bad();
    catIds.add(c.id);
  }
  const docIds = new Set();
  const paths = new Set();
  let files = 0;
  for (const d of m.documents) {
    if (!isInt(d?.id) || docIds.has(d.id) || !catIds.has(d.categoryId) || !isText(d.name, 500) || !isText(d.originalFilename, 500)) throw bad();
    docIds.add(d.id);
    if (d.file !== null) {
      const f = d.file;
      if (!f || !DOC_PATH.test(f.path) || !isInt(f.size) || !HEX64.test(f.sha256) || paths.has(f.path)) throw bad();
      paths.add(f.path);
      files++;
    }
  }
  if (m.counts.files !== files) throw bad();
  return m;
}

/* ---------------- the service ---------------- */

/**
 * @param {object} deps
 * @param {object} deps.db        createDatabase() instance (needs snapshot / attach / transaction)
 * @param {object} deps.storage   document storage: { exists, readBase64, write, remove }
 * @param {object} deps.scratch   temporary files: { write(path,b64), append(path,b64), size(path), read(path,offset,length)->Uint8Array, remove(path), exists(path) }
 * @param {()=>Promise<void>} [deps.afterRestore]  e.g. documents.reconcile + thumbnail rebuild (best effort)
 * @param {()=>Promise<number|null>} [deps.freeSpace]  free bytes on the device, when it can be asked
 */
export function createBackupService({ db, storage, scratch, afterRestore, freeSpace, now = () => new Date(), appVersion = '' }) {
  const sourceOf = async (path) => ({ size: await scratch.size(path), read: (offset, length) => scratch.read(path, offset, length) });
  const utf8 = new TextDecoder();

  /** Opens the snapshot inside an archive next to the live database, checks it and returns what is in it. */
  async function readDatabase(base64) {
    const head = new TextDecoder('latin1').decode(base64ToBytes(base64.slice(0, 24)).subarray(0, 16));
    if (head !== SQLITE_MAGIC) throw new BackupError('BACKUP_INVALID', MSG.noDatabase);
    let handle;
    try { handle = await db.attach(base64); } catch { throw new BackupError('BACKUP_INVALID', MSG.noDatabase); }
    try {
      const integrity = await db.all('PRAGMA bk.integrity_check;');
      if (integrity.length !== 1 || String(Object.values(integrity[0])[0]).toLowerCase() !== 'ok') throw new BackupError('BACKUP_CORRUPT', MSG.corrupt);
      const userVersion = Number((await db.all('PRAGMA bk.user_version;'))[0]?.user_version ?? 0);
      const tables = (await db.all("SELECT name FROM bk.sqlite_master WHERE type = 'table';")).map((r) => r.name);
      if (!tables.includes('categories') || !tables.includes('documents')) throw new BackupError('BACKUP_INVALID', MSG.noDatabase);
      const categories = await db.all('SELECT * FROM bk.categories ORDER BY id;');
      const documents = await db.all('SELECT * FROM bk.documents ORDER BY id;');
      return { userVersion, categories, documents };
    } catch (err) {
      if (err instanceof BackupError) throw err;
      throw new BackupError('BACKUP_INVALID', MSG.noDatabase);
    } finally {
      await handle.detach().catch(() => {});
    }
  }

  /**
   * Checks an archive on disk. `deep` also reads every document file and compares SHA-256 (used right after creating a
   * backup and while restoring); without it the structure, manifest, database and file sizes are checked.
   */
  async function verify(path, { deep = false, keepDatabase = false } = {}) {
    let zip;
    try { zip = await openZip(await sourceOf(path)); } catch (err) { throw wrapZipError(err); }
    try {
      const mEntry = zip.entries.get(MANIFEST_ENTRY);
      if (!mEntry) throw new BackupError('BACKUP_INVALID', MSG.invalid);
      const manifest = parseManifest(utf8.decode(await zip.read(mEntry)));
      const dEntry = zip.entries.get(DB_ENTRY);
      if (!dEntry || dEntry.size !== manifest.database.size) throw new BackupError('BACKUP_INVALID', MSG.invalid);
      const dbBytes = await zip.read(dEntry);
      if (await sha256Hex(dbBytes) !== manifest.database.sha256) throw new BackupError('BACKUP_CORRUPT', MSG.corrupt);
      const dbBase64 = bytesToBase64(dbBytes);
      const snap = await readDatabase(dbBase64);
      if (snap.userVersion !== manifest.schemaVersion) throw new BackupError('BACKUP_INVALID', MSG.invalid);
      // the database and the manifest must describe the same categories and documents
      if (snap.categories.length !== manifest.categories.length || snap.documents.length !== manifest.documents.length) throw new BackupError('BACKUP_INVALID', MSG.invalid);
      const dbCat = new Map(snap.categories.map((c) => [c.id, c]));
      for (const c of manifest.categories) if (!dbCat.has(c.id) || dbCat.get(c.id).name !== c.name || (dbCat.get(c.id).slug ?? null) !== c.slug) throw new BackupError('BACKUP_INVALID', MSG.invalid);
      const dbDoc = new Map(snap.documents.map((d) => [d.id, d]));
      for (const d of manifest.documents) {
        const row = dbDoc.get(d.id);
        if (!row || row.category_id !== d.categoryId || row.name !== d.name || (d.file && row.file_path !== d.file.path)) throw new BackupError('BACKUP_INVALID', MSG.invalid);
        if (!d.file && row.file_path && !d.isDemo) { // a document whose file was already missing when the backup was made
          const listed = (manifest.warnings ?? []).some((w) => w.code === 'FILE_MISSING' && Array.isArray(w.documentIds) && w.documentIds.includes(d.id));
          if (!listed) throw new BackupError('BACKUP_INVALID', MSG.invalid);
        }
        if (d.file) {
          const entry = zip.entries.get(d.file.path);
          if (!entry || entry.size !== d.file.size) throw new BackupError('BACKUP_INVALID', MSG.invalid);
          if (deep && await sha256Hex(await zip.read(entry)) !== d.file.sha256) throw new BackupError('BACKUP_CORRUPT', MSG.corrupt);
        }
      }
      return { manifest, zip, ...(keepDatabase ? { dbBase64, snapshot: snap } : {}) };
    } catch (err) {
      throw wrapZipError(err);
    }
  }

  function summarize(manifest, size) {
    return {
      createdAt: manifest.createdAt, formatVersion: manifest.formatVersion, schemaVersion: manifest.schemaVersion, size,
      categories: manifest.categories.length, customCategories: manifest.categories.filter((c) => c.isCustom).length,
      documents: manifest.documents.length, files: manifest.counts.files,
      withoutFile: manifest.documents.filter((d) => !d.file && !d.isDemo).length,
    };
  }

  const service = {
    /**
     * Builds a complete backup in the scratch folder, validates it and returns where it is. Nothing is uploaded or saved
     * anywhere else: the caller decides what happens next. On any failure the half-written file is deleted.
     */
    async createBackup({ onProgress = () => {}, shouldCancel = () => false } = {}) {
      const check = () => { if (shouldCancel()) throw new BackupError('BACKUP_CANCELLED', MSG.cancelled); };
      const createdAt = now();
      const fileName = backupFileName(createdAt);
      const path = `${BACKUP_DIR}/${fileName}`;
      try {
        onProgress({ stage: 'prepare' });
        const snap = await db.snapshot(); // consistent copy; the live database is not modified
        check();
        const content = await readDatabase(snap.data); // proves the snapshot opens, passes integrity_check and holds the rows we list
        const categories = content.categories;
        const documents = content.documents;
        const catById = new Map(categories.map((c) => [c.id, c]));

        onProgress({ stage: 'collect', total: documents.length });
        const withFile = [];
        const missing = [];
        for (const d of documents) {
          if (d.is_demo === 1 || !d.file_path) continue; // sample entries have no file
          if (!DOC_PATH.test(d.file_path) || !(await storage.exists(d.file_path))) { missing.push(d.id); continue; }
          withFile.push(d);
        }
        check();

        const fileInfo = new Map();
        let dbInfo = null;
        const entries = [{
          path: DB_ENTRY,
          date: createdAt,
          read: async () => {
            const bytes = base64ToBytes(snap.data);
            dbInfo = { path: DB_ENTRY, size: bytes.length, sha256: await sha256Hex(bytes) };
            return snap.data;
          },
        }];
        for (const d of withFile) {
          entries.push({
            path: d.file_path,
            date: new Date(d.created_at),
            read: async () => {
              check();
              const b64 = await storage.readBase64(d.file_path);
              const bytes = base64ToBytes(b64);
              fileInfo.set(d.id, { path: d.file_path, size: bytes.length, sha256: await sha256Hex(bytes) });
              return b64;
            },
          });
        }
        entries.push({ // written last: it lists the sizes and checksums gathered while the other entries were written
          path: MANIFEST_ENTRY,
          date: createdAt,
          read: async () => {
            const manifest = {
              format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION, schemaVersion: content.userVersion,
              createdAt: createdAt.toISOString(), app: { name: 'MyDocs', version: appVersion },
              counts: { categories: categories.length, documents: documents.length, files: fileInfo.size },
              database: dbInfo,
              categories: categories.map((c) => ({
                id: c.id, slug: c.slug ?? null, name: c.name, icon: c.icon ?? null, sortOrder: c.sort_order ?? 0,
                isCustom: c.is_custom === 1, createdAt: c.created_at ?? null,
              })),
              documents: documents.map((d) => ({
                id: d.id, categoryId: d.category_id, categorySlug: catById.get(d.category_id)?.slug ?? null, name: d.name,
                originalFilename: d.original_filename, fileType: d.file_type, mimeType: d.mime_type ?? null,
                createdAt: d.created_at, updatedAt: d.updated_at, expiryDate: d.expiry_date ?? null, isDemo: d.is_demo === 1,
                file: fileInfo.get(d.id) ?? null,
              })),
              excluded: ['thumbnails', 'temporary share files', 'caches and logs', 'App Lock state', 'Google sign-in tokens', 'device preferences'],
              warnings: missing.length ? [{ code: 'FILE_MISSING', documentIds: missing }] : [],
            };
            return bytesToBase64(new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
          },
        });

        await scratch.remove(path).catch(() => {});
        await scratch.write(path, '');
        await writeZip({
          entries, append: (chunk) => scratch.append(path, chunk),
          onProgress: (done, total) => onProgress({ stage: 'create', done, total }),
        });
        check();
        onProgress({ stage: 'validate' });
        const { manifest } = await verify(path, { deep: true });
        const size = await scratch.size(path);
        return { path, fileName, size, createdAt: createdAt.toISOString(), summary: summarize(manifest, size), missingFiles: missing.length };
      } catch (err) {
        await scratch.remove(path).catch(() => {});
        if (err instanceof BackupError) throw err;
        if (err instanceof ZipError) throw wrapZipError(err);
        throw new BackupError('BACKUP_FAILED', MSG.failed);
      }
    },

    /** Reads and validates an archive (already copied to `path` in the scratch folder) and describes it. Changes nothing. */
    async inspect(path) {
      const { manifest } = await verify(path);
      return summarize(manifest, await scratch.size(path));
    },

    /**
     * mode 'replace': the app's data becomes exactly the backup's (original ids, categories, order, documents).
     * mode 'merge':   adds what the backup has and the app lacks (categories matched by slug or name, documents by file).
     * Throws BackupError; on failure the existing data is unchanged.
     */
    async restore(path, { mode = 'replace', onProgress = () => {} } = {}) {
      if (mode !== 'replace' && mode !== 'merge') throw new BackupError('RESTORE_FAILED', MSG.restoreFailed);
      onProgress({ stage: 'validate' });
      const { manifest, zip, dbBase64 } = await verify(path, { keepDatabase: true });

      const placed = []; // files written to storage during this restore: { path, previous }
      const undoFiles = async () => {
        for (const p of placed.reverse()) {
          if (p.previous === null) await storage.remove(p.path).catch(() => {});
          else await storage.write(p.path, p.previous).catch(() => {});
        }
      };
      let attached = null;
      try {
        attached = await db.attach(dbBase64);

        // which files does this restore need to put in place?
        let wanted = manifest.documents.filter((d) => d.file);
        if (mode === 'merge') {
          const have = new Set((await db.all('SELECT file_path FROM main.documents WHERE file_path IS NOT NULL;')).map((r) => r.file_path));
          wanted = wanted.filter((d) => !d.isDemo && !have.has(d.file.path));
        }
        const needBytes = wanted.reduce((n, d) => n + d.file.size, 0);
        const free = freeSpace ? await freeSpace().catch(() => null) : null;
        if (typeof free === 'number' && free < needBytes * 1.1 + 1024 * 1024) {
          throw new BackupError('BACKUP_STORAGE', `There is not enough free storage to restore this backup (about ${Math.ceil(needBytes / 1_000_000)} MB needed). Free up space and try again.`, { needBytes });
        }

        // 1) files: verified (CRC + SHA-256) before each one is written; nothing in the database has changed yet
        for (const [i, d] of wanted.entries()) {
          onProgress({ stage: 'restore', done: i, total: wanted.length });
          const bytes = await zip.read(zip.entries.get(d.file.path));
          if (bytes.length !== d.file.size || await sha256Hex(bytes) !== d.file.sha256) throw new BackupError('BACKUP_CORRUPT', MSG.corrupt);
          const b64 = bytesToBase64(bytes);
          const exists = await storage.exists(d.file.path);
          const previous = exists ? await storage.readBase64(d.file.path).catch(() => null) : null;
          if (exists && previous === b64) continue; // already there, identical
          placed.push({ path: d.file.path, previous });
          await storage.write(d.file.path, b64);
        }
        onProgress({ stage: 'restore', done: wanted.length, total: wanted.length });

        // 2) the database: one transaction. Any error rolls everything back.
        const result = await db.transaction(async () => (mode === 'replace' ? replaceAll(manifest) : mergeInto(manifest)));
        await attached.detach().catch(() => {});
        attached = null;
        try { await afterRestore?.(); } catch { /* cleanup of orphans / thumbnails is best effort */ }
        return { mode, ...result, files: wanted.length };
      } catch (err) {
        await undoFiles();
        if (attached) await attached.detach().catch(() => {});
        if (err instanceof BackupError) throw err;
        if (err instanceof ZipError) throw wrapZipError(err); // a damaged entry found while reading the files
        throw new BackupError('RESTORE_FAILED', MSG.restoreFailed);
      }
    },
  };

  /* ----- restore: database part (runs inside a transaction, `bk` is the attached backup) ----- */

  async function columnsOf(table) {
    return new Set((await db.all(`PRAGMA bk.table_info(${table});`)).map((r) => r.name));
  }
  /** SELECT list for `target` columns: the backup's column when it has one, otherwise a default (older backups). */
  const pick = (have, column, fallback) => (have.has(column) ? `"${column}"` : fallback);

  async function replaceAll(manifest) {
    const cat = await columnsOf('categories');
    const doc = await columnsOf('documents');
    for (const required of ['id', 'name']) if (!cat.has(required)) throw new BackupError('BACKUP_INVALID', MSG.noDatabase);
    for (const required of ['id', 'category_id', 'name', 'original_filename', 'file_type', 'created_at', 'updated_at']) if (!doc.has(required)) throw new BackupError('BACKUP_INVALID', MSG.noDatabase);
    await db.run('DELETE FROM documents;');
    await db.run('DELETE FROM categories;');
    const stamp = new Date().toISOString();
    await db.run(
      `INSERT INTO categories (id, slug, name, icon, sort_order, is_custom, created_at)
       SELECT ${pick(cat, 'id', 'NULL')}, ${pick(cat, 'slug', 'NULL')}, ${pick(cat, 'name', 'NULL')}, ${pick(cat, 'icon', 'NULL')},
              ${pick(cat, 'sort_order', '0')}, ${pick(cat, 'is_custom', '0')}, ${pick(cat, 'created_at', `'${stamp}'`)}
         FROM bk.categories ORDER BY id;`);
    await db.run(
      `INSERT INTO documents (id, category_id, name, original_filename, file_type, mime_type, file_path, file_size, created_at, updated_at, expiry_date, is_demo, seed_key, thumb_path)
       SELECT ${pick(doc, 'id', 'NULL')}, ${pick(doc, 'category_id', 'NULL')}, ${pick(doc, 'name', 'NULL')}, ${pick(doc, 'original_filename', 'NULL')},
              ${pick(doc, 'file_type', 'NULL')}, ${pick(doc, 'mime_type', 'NULL')}, ${pick(doc, 'file_path', 'NULL')}, ${pick(doc, 'file_size', 'NULL')},
              ${pick(doc, 'created_at', 'NULL')}, ${pick(doc, 'updated_at', 'NULL')}, ${pick(doc, 'expiry_date', 'NULL')}, ${pick(doc, 'is_demo', '0')},
              ${pick(doc, 'seed_key', 'NULL')}, NULL
         FROM bk.documents ORDER BY id;`);
    // backups from before user categories were ordered after the built-in ones
    await db.run('UPDATE categories SET sort_order = sort_order + ? WHERE is_custom = 1 AND sort_order < ?;', [CUSTOM_ORDER_BASE, CUSTOM_ORDER_BASE]);
    await db.reseed(); // a built-in category the backup does not know (e.g. added later) is created again
    await verifyRestored(manifest.documents.length, manifest.categories.length);
    return { categories: manifest.categories.length, documents: manifest.documents.length, addedCategories: manifest.categories.length, addedDocuments: manifest.documents.length };
  }

  async function mergeInto(manifest) {
    const bkCats = await db.all('SELECT * FROM bk.categories ORDER BY id;');
    const bkDocs = await db.all('SELECT * FROM bk.documents ORDER BY id;');
    const local = await db.all('SELECT id, slug, name FROM categories;');
    const bySlug = new Map(local.filter((c) => c.slug).map((c) => [c.slug, c.id]));
    const byName = new Map(local.map((c) => [c.name.toLowerCase(), c.id]));
    const taken = new Set(byName.keys());
    const map = new Map();
    let addedCategories = 0;
    for (const c of bkCats) {
      const matched = (c.slug && bySlug.get(c.slug)) ?? byName.get(String(c.name).toLowerCase());
      if (matched) { map.set(c.id, matched); continue; }
      let name = c.name;
      for (let n = 1; taken.has(name.toLowerCase()); n++) name = `${c.name} (restored${n > 1 ? ` ${n}` : ''})`; // cannot happen after the name match above, kept as a guard
      taken.add(name.toLowerCase());
      const maxOrder = Number((await db.all('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories;'))[0].m);
      const sortOrder = c.is_custom === 1 ? Math.max(CUSTOM_ORDER_BASE, maxOrder) + 1 : (c.sort_order ?? 0);
      await db.run(
        'INSERT INTO categories (slug, name, icon, sort_order, is_custom, created_at) VALUES (?, ?, ?, ?, ?, ?);',
        [c.slug ?? null, name, c.icon ?? null, sortOrder, c.is_custom === 1 ? 1 : 0, c.created_at ?? new Date().toISOString()]);
      const row = (await db.all('SELECT id FROM categories WHERE name = ? COLLATE NOCASE;', [name]))[0];
      map.set(c.id, row.id);
      addedCategories++;
    }
    const have = new Set((await db.all('SELECT file_path FROM documents WHERE file_path IS NOT NULL;')).map((r) => r.file_path));
    let addedDocuments = 0;
    for (const d of bkDocs) {
      if (d.is_demo === 1 || !d.file_path || have.has(d.file_path)) continue; // samples are never merged; a document that is already here stays as it is
      const categoryId = map.get(d.category_id);
      if (!categoryId) throw new BackupError('BACKUP_INVALID', MSG.invalid);
      await db.run(
        `INSERT INTO documents (category_id, name, original_filename, file_type, mime_type, file_path, file_size, created_at, updated_at, expiry_date, is_demo, seed_key, thumb_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL);`,
        [categoryId, d.name, d.original_filename, d.file_type, d.mime_type ?? null, d.file_path, d.file_size ?? null, d.created_at, d.updated_at, d.expiry_date ?? null]);
      have.add(d.file_path);
      addedDocuments++;
    }
    await db.reseed();
    await verifyRestored(null, null);
    return { categories: manifest.categories.length, documents: manifest.documents.length, addedCategories, addedDocuments };
  }

  /** Last check inside the transaction: if it fails, everything is rolled back. */
  async function verifyRestored(documentCount, categoryCount) {
    const orphans = await db.all('SELECT d.id FROM documents d LEFT JOIN categories c ON c.id = d.category_id WHERE c.id IS NULL;');
    if (orphans.length) throw new BackupError('RESTORE_FAILED', MSG.restoreFailed);
    const fk = await db.all('PRAGMA foreign_key_check;');
    if (fk.length) throw new BackupError('RESTORE_FAILED', MSG.restoreFailed);
    if (documentCount !== null) {
      const docs = Number((await db.all('SELECT COUNT(*) AS n FROM documents;'))[0].n);
      if (docs !== documentCount) throw new BackupError('RESTORE_FAILED', MSG.restoreFailed);
    }
    if (categoryCount !== null) {
      const cats = Number((await db.all('SELECT COUNT(*) AS n FROM categories;'))[0].n);
      if (cats < categoryCount) throw new BackupError('RESTORE_FAILED', MSG.restoreFailed);
    }
  }

  return service;
}
