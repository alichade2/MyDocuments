// Document service: coordinates SQLite metadata with files in app-private storage.
// Storage / picker / viewer are injected adapters so no native API reaches the UI.

import { normalizeQuery, escapeLike, parseDateQuery } from './search.js';
import { writeZip, uniqueEntryPaths, ZIP_LIMITS, bytesToBase64 } from './zip.js';
import { DEFAULT_CATEGORY_ICON, isChoosableIcon } from './icons.js';
import { CUSTOM_ORDER_BASE } from './seed.js';
import { checkSize, sizeLimitBytes, getSizeLimitMb, byteLengthOfBase64, MB } from './sizelimit.js';
import { UNRESTRICTED_ACCESS } from './access.js';

export const DOCS_DIR = 'documents';
const SHARE_DIR = 'share';
export const THUMBS_DIR = 'thumbnails'; // outside DOCS_DIR so reconcile can sweep each independently
export const IMAGE_TYPES = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
export const MAX_NAME_LENGTH = 120;

export const SUPPORTED_TYPES = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  txt: 'text/plain',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

export const DEMO_MESSAGE = 'This is sample document data. Import a real document to preview it.';

const THUMB_TIMEOUT_MS = 8000;
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class DocumentError extends Error {
  constructor(code, message) { super(message); this.name = 'DocumentError'; this.code = code; }
}

/**
 * The single place where a document size is enforced (picked files, camera images and the final import all call it).
 * Throws a DocumentError (FILE_TOO_LARGE / FILE_TOO_LARGE_MAX / FILE_SIZE_UNKNOWN) when the size is not allowed.
 * @param {number} bytes real size in bytes @param {'file'|'capture'} kind @param {{atLeast?: boolean, limitMb?: number}} [opts]
 */
export function enforceSize(bytes, kind = 'file', opts = {}) {
  const problem = checkSize(bytes, { kind, ...opts });
  if (problem) throw Object.assign(new DocumentError(problem.code, problem.message), { size: problem.size, limitMb: problem.limitMb });
}

export function extensionOf(filename) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(filename ?? ''));
  return m ? m[1].toLowerCase() : '';
}

/** Suggested display name for a picked file: filename without its extension, trimmed to the max length. */
export function suggestName(filename) {
  const base = String(filename ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/\s+/g, ' ').trim();
  return base.slice(0, MAX_NAME_LENGTH);
}

/** File name for a shared copy: the document's display name made safe for file systems, plus its real extension. */
export function shareFileName(displayName, ext) {
  const base = String(displayName ?? '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, 80) || 'document';
  return `${base}.${ext}`;
}

export const MAX_CATEGORY_NAME_LENGTH = 40;

/** Trims, collapses inner whitespace and rejects empty / over-long category names. Duplicates are checked against the database. */
export function validateCategoryName(name) {
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) throw new DocumentError('INVALID_CATEGORY_NAME', 'Please enter a category name.');
  if (clean.length > MAX_CATEGORY_NAME_LENGTH) throw new DocumentError('INVALID_CATEGORY_NAME', `Category name must be ${MAX_CATEGORY_NAME_LENGTH} characters or fewer.`);
  return clean;
}

export function validateName(name) {
  const trimmed = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed) throw new DocumentError('INVALID_NAME', 'Document name cannot be empty.');
  if (trimmed.length > MAX_NAME_LENGTH) throw new DocumentError('INVALID_NAME', `Name must be ${MAX_NAME_LENGTH} characters or fewer.`);
  return trimmed;
}

function toRecord(r) {
  return {
    id: r.id, categoryId: r.category_id, name: r.name, originalFilename: r.original_filename,
    fileType: r.file_type, mimeType: r.mime_type, filePath: r.file_path, fileSize: r.file_size,
    createdAt: r.created_at, updatedAt: r.updated_at, expiryDate: r.expiry_date, isDemo: r.is_demo === 1, thumbPath: r.thumb_path ?? null,
  };
}

/**
 * @param {object} deps
 * @param {object} deps.db       createDatabase() instance
 * @param {object} deps.storage  { write(path, base64), remove(path), exists(path), list(dir), uri(path) }
 * @param {object} [deps.picker] { pick() -> {name, mimeType, size, data(base64)} | null }
 * @param {object} [deps.viewer] { open(uri, mimeType) }
 * @param {object} [deps.camera] { capture() -> {mimeType, data(base64)} | null } (throws DocumentError on denial/unavailable)
 * @param {object} [deps.sharer] { share({uri, title}) -> true | false(cancelled) }  (throws DocumentError on failure)
 * @param {Function} [deps.thumbnailer] async (base64, mimeType) -> base64 JPEG thumbnail | null
 */
export function createDocumentService({ db, storage, picker, viewer, camera, sharer, thumbnailer, access = UNRESTRICTED_ACCESS, now = () => new Date().toISOString(), uuid = () => crypto.randomUUID() }) {
  // Plan rules (see access.js) are applied HERE, at the persistence boundary, not only in the screens.
  /** The size limit for the next document: the saved setting, never above what the current plan allows. */
  const limitMb = () => { const cap = access.sizeCapMb(); const effective = getSizeLimitMb(); return cap === null ? effective : Math.min(effective, cap); };
  /** Real (non-sample) documents saved so far: what the Basic limit counts. */
  const countDocuments = async () => Number((await db.all('SELECT COUNT(*) AS n FROM documents WHERE is_demo = 0;'))[0].n);
  async function requireCategory(categoryId) {
    const rows = await db.all('SELECT id FROM categories WHERE id = ?;', [categoryId]);
    if (!rows.length) throw new DocumentError('INVALID_CATEGORY', 'Unknown category.');
  }
  async function getCategoryRow(id) {
    const rows = await db.all('SELECT * FROM categories WHERE id = ?;', [id]);
    if (!rows.length) throw new DocumentError('INVALID_CATEGORY', 'Unknown category.');
    return rows[0];
  }
  async function getRow(id) {
    const rows = await db.all('SELECT * FROM documents WHERE id = ?;', [id]);
    if (!rows.length) throw new DocumentError('NOT_FOUND', 'Document not found.');
    return rows[0];
  }

  const service = {
    async listCategories() {
      return db.all('SELECT id, slug, name, icon, sort_order, is_custom, created_at FROM categories ORDER BY sort_order, id;');
    },

    /** Categories with their document counts (for Manage Categories). */
    async listCategoriesWithCounts() {
      const rows = await db.all(
        `SELECT c.id, c.slug, c.name, c.icon, c.sort_order, c.is_custom, c.created_at, COUNT(d.id) AS doc_count
           FROM categories c LEFT JOIN documents d ON d.category_id = c.id
          GROUP BY c.id ORDER BY c.sort_order, c.id;`);
      return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, icon: r.icon, sortOrder: r.sort_order, isCustom: r.is_custom === 1, createdAt: r.created_at, docCount: r.doc_count }));
    },

    /** Creates a user category: unique id + slug, trimmed name unique ignoring case, one of the offered icons (default: folder). */
    async createCategory({ name, icon } = {}) {
      const clean = validateCategoryName(name);
      const iconKey = icon == null || icon === '' ? DEFAULT_CATEGORY_ICON : icon;
      if (!isChoosableIcon(iconKey)) throw new DocumentError('INVALID_ICON', 'Please choose one of the available icons.');
      const slug = `custom-${uuid()}`;
      const duplicate = () => new DocumentError('DUPLICATE_CATEGORY', 'A category with this name already exists.');
      try {
        await db.transaction(async () => {
          if ((await db.all('SELECT id FROM categories WHERE name = ? COLLATE NOCASE;', [clean])).length) throw duplicate();
          await db.run(
            `INSERT INTO categories (slug, name, icon, sort_order, is_custom, created_at)
             VALUES (?, ?, ?, (SELECT MAX(COALESCE(MAX(sort_order), 0), ?) + 1 FROM categories), 1, ?);`,
            [slug, clean, iconKey, CUSTOM_ORDER_BASE, now()]); // user categories always sort after the built-in ones
        });
      } catch (err) {
        if (err instanceof DocumentError) throw err;
        if (/UNIQUE/i.test(String(err?.message ?? err))) throw duplicate(); // the NOCASE index is the final guard
        throw err;
      }
      return (await service.listCategoriesWithCounts()).find((c) => c.slug === slug);
    },

    /** Renames / re-icons a custom category. Documents keep pointing at the category id, so nothing is re-linked. */
    async updateCategory(id, { name, icon } = {}) {
      const row = await getCategoryRow(id);
      if (row.is_custom !== 1) throw new DocumentError('CATEGORY_LOCKED', 'Built-in categories cannot be changed.');
      const clean = name === undefined ? row.name : validateCategoryName(name);
      const iconKey = icon === undefined ? row.icon : icon;
      if (!isChoosableIcon(iconKey) && iconKey !== row.icon) throw new DocumentError('INVALID_ICON', 'Please choose one of the available icons.');
      try {
        await db.transaction(async () => {
          if ((await db.all('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND id <> ?;', [clean, id])).length) {
            throw new DocumentError('DUPLICATE_CATEGORY', 'A category with this name already exists.');
          }
          await db.run('UPDATE categories SET name = ?, icon = ? WHERE id = ?;', [clean, iconKey, id]);
        });
      } catch (err) {
        if (err instanceof DocumentError) throw err;
        if (/UNIQUE/i.test(String(err?.message ?? err))) throw new DocumentError('DUPLICATE_CATEGORY', 'A category with this name already exists.');
        throw err;
      }
      return (await service.listCategoriesWithCounts()).find((c) => c.id === id);
    },

    /**
     * Deletes a custom category. A category that still has documents is never deleted silently: the caller must give
     * `moveTo` (another category id) and the documents are re-pointed there. No document file is touched.
     */
    async deleteCategory(id, { moveTo } = {}) {
      const row = await getCategoryRow(id);
      if (row.is_custom !== 1) throw new DocumentError('CATEGORY_LOCKED', 'Built-in categories cannot be deleted.');
      const [{ n }] = await db.all('SELECT COUNT(*) AS n FROM documents WHERE category_id = ?;', [id]);
      if (n > 0) {
        if (moveTo == null) {
          const err = new DocumentError('CATEGORY_NOT_EMPTY', `This category still contains ${n} ${n === 1 ? 'document' : 'documents'}. Choose where to move them first.`);
          err.count = n;
          throw err;
        }
        if (Number(moveTo) === id) throw new DocumentError('INVALID_CATEGORY', 'Choose a different category to move the documents to.');
        await getCategoryRow(Number(moveTo)); // must exist
      }
      await db.transaction(async () => {
        if (n > 0) await db.run('UPDATE documents SET category_id = ? WHERE category_id = ?;', [Number(moveTo), id]);
        await db.run('DELETE FROM categories WHERE id = ?;', [id]);
      });
      return { moved: n };
    },

    /** Documents of a category (all when categoryId is omitted); flags records whose file is gone. */
    async list(categoryId) {
      const rows = categoryId == null
        ? await db.all('SELECT * FROM documents ORDER BY name COLLATE NOCASE, id;')
        : await db.all('SELECT * FROM documents WHERE category_id = ? ORDER BY name COLLATE NOCASE, id;', [categoryId]);
      return Promise.all(rows.map(async (r) => ({ ...toRecord(r), missing: r.is_demo !== 1 && !(await storage.exists(r.file_path)) })));
    },

    /** Every document with its category (ordered by category, then name) - no per-file checks, for the All Documents list. */
    async listAll() {
      const rows = await db.all(
        `SELECT d.*, c.name AS category_name, c.slug AS category_slug, c.sort_order AS category_order
           FROM documents d JOIN categories c ON c.id = d.category_id
          ORDER BY c.sort_order, c.id, d.name COLLATE NOCASE, d.id;`);
      return rows.map((r) => ({ ...toRecord(r), categoryName: r.category_name, categorySlug: r.category_slug, categoryOrder: r.category_order, missing: false }));
    },

    async get(id) { return toRecord(await getRow(id)); },

    /**
     * Global search over ALL categories: case-insensitive partial match on the display name and original file
     * name, plus date matching (created / expiry date) when the query reads as a date (see search.js).
     * Every matching document is its own result (identified by id) with its category attached.
     */
    async search(query, { limit = 100 } = {}) {
      const text = normalizeQuery(query).toLowerCase();
      if (!text) return [];
      const like = `%${escapeLike(text)}%`;
      const datePattern = parseDateQuery(text);
      const dateSql = datePattern ? ' OR d.created_at LIKE ? OR d.expiry_date LIKE ?' : '';
      const where = `(LOWER(d.name) LIKE ? ESCAPE '\\' OR LOWER(d.original_filename) LIKE ? ESCAPE '\\'${dateSql})`;
      const rows = await db.all(
        `SELECT d.*, c.name AS category_name, c.slug AS category_slug, c.icon AS category_icon
           FROM documents d JOIN categories c ON c.id = d.category_id
          WHERE ${where}
          ORDER BY (LOWER(d.name) LIKE ? ESCAPE '\\') DESC, d.name COLLATE NOCASE, d.id
          LIMIT ?;`,
        [like, like, ...(datePattern ? [datePattern, datePattern] : []), `${escapeLike(text)}%`, limit]);
      return rows.map((r) => ({ ...toRecord(r), categoryName: r.category_name, categorySlug: r.category_slug, categoryIcon: r.category_icon }));
    },

    /** file: { name, mimeType, size, data(base64) } */
    async importFile(categoryId, file, displayName) {
      await requireCategory(categoryId);
      access.assertCanCreateDocument(await countDocuments()); // early, before anything is written
      const ext = extensionOf(file?.name);
      if (!SUPPORTED_TYPES[ext]) throw new DocumentError('UNSUPPORTED_TYPE', `Unsupported file type ".${ext || '?'}".`);
      if (!file.data) throw new DocumentError('EMPTY_FILE', 'The selected file has no content.');
      // Final persistence boundary: whatever path the file came from, its real size is judged here against the limit in force now.
      const actualSize = byteLengthOfBase64(file.data);
      enforceSize(Math.max(actualSize, Number.isFinite(file.size) ? file.size : 0), file.source === 'camera' ? 'capture' : 'file', { limitMb: limitMb() });
      const name = validateName(displayName ?? file.name.replace(/\.[^.]+$/, ''));
      const id = uuid();
      const filePath = `${DOCS_DIR}/${id}.${ext}`; // collision-resistant; duplicate display names are fine
      await storage.write(filePath, file.data);
      let thumbPath = null;
      if (thumbnailer && IMAGE_TYPES.has(ext)) { // best effort: a missing thumbnail never blocks saving
        try {
          const thumb = await withTimeout(thumbnailer(file.data, SUPPORTED_TYPES[ext]), THUMB_TIMEOUT_MS);
          if (thumb) { thumbPath = `${THUMBS_DIR}/${id}.jpg`; await storage.write(thumbPath, thumb); }
        } catch { thumbPath = null; }
      }
      try {
        const ts = now();
        await db.transaction(async () => {
          access.assertCanCreateDocument(await countDocuments()); // authoritative: counted inside the same serialised transaction as the insert
          await db.run(
            `INSERT INTO documents (category_id, name, original_filename, file_type, mime_type, file_path, file_size, created_at, updated_at, thumb_path)
             VALUES (?,?,?,?,?,?,?,?,?,?);`,
            [categoryId, name, file.name, ext, SUPPORTED_TYPES[ext], filePath, actualSize, ts, ts, thumbPath]);
        });
      } catch (err) {
        await storage.remove(filePath).catch(() => {}); // keep file system and DB consistent
        if (thumbPath) await storage.remove(thumbPath).catch(() => {});
        throw err;
      }
      const rows = await db.all('SELECT * FROM documents WHERE file_path = ?;', [filePath]);
      return toRecord(rows[0]);
    },

    /** Throws EntitlementError('DOCUMENT_LIMIT') when the current plan cannot save another document. */
    async assertCanCreateDocument() { access.assertCanCreateDocument(await countDocuments()); },
    countDocuments,

    /** Step 1 of the upload flow: let the user pick a file. Returns null when cancelled. */
    async pickFile() {
      if (!picker) throw new DocumentError('NO_PICKER', 'File picking is not available on this platform.');
      access.assertCanCreateDocument(await countDocuments()); // a full Basic account is told before the picker even opens
      const picked = await picker.pick();
      if (!picked) return null;
      const opts = { limitMb: limitMb() };
      if (typeof picked.read !== 'function') { // adapter already read the data: validate what it returned
        enforceSize(Math.max(byteLengthOfBase64(picked.data), Number.isFinite(picked.size) ? picked.size : 0), 'file', opts);
        return picked;
      }
      // Lazy picker (Android): the size reported by the provider is checked BEFORE a single byte is read or copied.
      if (picked.size > 0) enforceSize(picked.size, 'file', opts);
      const res = await picked.read({ maxBytes: sizeLimitBytes(opts.limitMb) });
      if (res.tooLarge) enforceSize(res.size, 'file', { ...opts, atLeast: res.atLeast });
      enforceSize(res.size, 'file', opts); // the bytes actually received, in case the provider's metadata was wrong
      return { name: picked.name, mimeType: picked.mimeType, size: res.size, data: res.data };
    },

    /** Camera capture (step 1 of the capture flow). Returns a file-like object, or null when cancelled. */
    async capturePhoto() {
      if (!camera) throw new DocumentError('NO_CAMERA', 'The camera is not available on this platform.');
      access.assertCanCreateDocument(await countDocuments()); // no point opening the camera when the photo could not be saved
      const shot = await camera.capture();
      if (!shot) return null;
      const d = new Date(now());
      const p = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      const size = byteLengthOfBase64(shot.data);
      enforceSize(size, 'capture', { limitMb: limitMb() }); // the final image, checked again here (the adapter checks the file before reading it)
      return { name: `Captured_${stamp}.jpg`, mimeType: 'image/jpeg', size, data: shot.data, source: 'camera' };
    },

    /** URL the WebView can display for the document's thumbnail (null when there is none). */
    async thumbnailSrc(doc) {
      return doc?.thumbPath && (await storage.exists(doc.thumbPath)) ? storage.src(doc.thumbPath) : null;
    },

    /** URL for the full-size image of an image document (used by the full-screen viewer). */
    async imageSrc(id) {
      const row = await getRow(id);
      if (row.is_demo === 1) throw new DocumentError('DEMO_DOCUMENT', DEMO_MESSAGE);
      if (!IMAGE_TYPES.has(row.file_type)) throw new DocumentError('NOT_IMAGE', 'This document is not an image.');
      if (!(await storage.exists(row.file_path))) throw new DocumentError('FILE_MISSING', 'The file for this document is missing from storage.');
      return storage.src(row.file_path);
    },

    /**
     * Opens the system share sheet with the document file attached. A temporary copy named after the
     * document is staged in the cache (replacing any previous one); the stored original is never touched.
     * Returns true when the share sheet was used, false when the user cancelled.
     */
    async shareDocument(id) {
      const row = await getRow(id);
      if (row.is_demo === 1) throw new DocumentError('DEMO_DOCUMENT', 'This is sample document data, so there is no file to share. Import a real document first.');
      if (!sharer || !storage.stageForShare) throw new DocumentError('NO_SHARE', 'Sharing is only available in the Android app.');
      if (!row.file_path || !(await storage.exists(row.file_path))) {
        throw new DocumentError('FILE_MISSING', 'The file for this document is missing from storage, so it cannot be shared.');
      }
      let uri;
      try { uri = await storage.stageForShare(row.file_path, shareFileName(row.name, row.file_type)); } catch {
        throw new DocumentError('SHARE_FAILED', 'Could not prepare the file for sharing. Please try again.');
      }
      return sharer.share({ uri, title: row.name });
    },

    /**
     * Bundles the selected documents into ONE ZIP (entries "Category/Name.ext", duplicates renamed, never dropped)
     * in the cache and opens the native share sheet for it. Nothing is changed in the library. All-or-nothing:
     * if any selected document cannot be included, no archive is created or shared.
     * Returns { shared, fileName, count } - `shared` is false when the user dismissed the share sheet.
     */
    async shareSelectedAsZip(ids, { onProgress } = {}) {
      const wanted = [...new Set((ids ?? []).map(Number).filter(Number.isInteger))];
      if (!wanted.length) throw new DocumentError('NOTHING_SELECTED', 'Please select at least one document to share.');
      if (!sharer || !storage.beginShareFile) throw new DocumentError('NO_SHARE', 'Sharing is only available in the Android app.');

      const rows = [];
      for (let i = 0; i < wanted.length; i += 400) { // stay below SQLite's bound-parameter limit
        const part = wanted.slice(i, i + 400);
        rows.push(...await db.all(
          `SELECT d.*, c.name AS category_name, c.sort_order AS category_order FROM documents d JOIN categories c ON c.id = d.category_id
            WHERE d.id IN (${part.map(() => '?').join(',')});`, part));
      }
      if (rows.length !== wanted.length) {
        throw new DocumentError('SELECTION_STALE', 'Some selected documents no longer exist. Please review your selection.');
      }
      rows.sort((a, b) => a.category_order - b.category_order || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id);

      const unavailable = [];
      for (const r of rows) {
        if (r.is_demo === 1 || !r.file_path || !(await storage.exists(r.file_path))) unavailable.push(r.name);
      }
      if (unavailable.length) {
        const shown = unavailable.slice(0, 3).map((n) => `"${n}"`).join(', ') + (unavailable.length > 3 ? ` and ${unavailable.length - 3} more` : '');
        const err = new DocumentError('ZIP_UNAVAILABLE', `${unavailable.length === 1 ? 'This document has' : 'These documents have'} no file that can be shared: ${shown}. Nothing was shared.`);
        err.names = unavailable;
        throw err;
      }
      if (rows.length > ZIP_LIMITS.maxEntries) throw new DocumentError('ZIP_TOO_LARGE', 'Too many documents for one ZIP file.');
      if (rows.reduce((n, r) => n + (r.file_size ?? 0), 0) > ZIP_LIMITS.maxBytes) {
        throw new DocumentError('ZIP_TOO_LARGE', 'The selected documents are too large for one ZIP file. Select fewer documents.');
      }

      const d = new Date(now());
      const p2 = (n) => String(n).padStart(2, '0');
      const fileName = `MyDocs_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.zip`;
      const paths = uniqueEntryPaths(rows.map((r) => ({ category: r.category_name, name: r.name, ext: r.file_type })));
      const entries = rows.map((r, i) => ({ path: paths[i], date: new Date(r.updated_at), read: () => storage.readBase64(r.file_path) }));

      try {
        await storage.beginShareFile(fileName); // clears the previous temporary share file
        await writeZip({ entries, append: (chunk) => storage.appendShareFile(fileName, chunk), onProgress });
        const uri = await storage.shareFileUri(fileName);
        const shared = await sharer.share({ uri, title: fileName.replace(/\.zip$/, '') });
        return { shared, fileName, count: rows.length };
      } catch (err) {
        await storage.clearShareCache?.().catch(() => {}); // never leave a half-written archive behind
        if (err instanceof DocumentError) throw err;
        const text = String(err?.message ?? err);
        if (/ENOSPC|No space|not enough space|storage/i.test(text)) throw new DocumentError('ZIP_NO_SPACE', 'Not enough free storage to create the ZIP file.');
        if (/too large|too many/i.test(text)) throw new DocumentError('ZIP_TOO_LARGE', text);
        throw new DocumentError('ZIP_FAILED', 'Could not create the ZIP file. Please try again.');
      }
    },

    async importFromPicker(categoryId) {
      const file = await service.pickFile();
      return file ? service.importFile(categoryId, file) : null;
    },

    /** Renames metadata only; the stored file is never touched. */
    async rename(id, newName) {
      const name = validateName(newName);
      await getRow(id);
      await db.transaction(() => db.run('UPDATE documents SET name = ?, updated_at = ? WHERE id = ?;', [name, now(), id]));
      return service.get(id);
    },

    async remove(id) {
      const row = await getRow(id);
      if (row.file_path && await storage.exists(row.file_path)) await storage.remove(row.file_path); // abort if file cannot be deleted
      if (row.thumb_path) await storage.remove(row.thumb_path).catch(() => {});
      await db.transaction(() => db.run('DELETE FROM documents WHERE id = ?;', [id]));
    },

    async open(id) {
      const row = await getRow(id);
      if (row.is_demo === 1) throw new DocumentError('DEMO_DOCUMENT', DEMO_MESSAGE);
      if (!(await storage.exists(row.file_path))) throw new DocumentError('FILE_MISSING', 'The file for this document is missing from storage.');
      if (!viewer) throw new DocumentError('NO_VIEWER', 'Previewing is not available on this platform.');
      await viewer.open(await storage.uri(row.file_path), row.mime_type);
    },

    /** Creates thumbnails for image documents that have none (after a restore: thumbnails are not part of a backup). */
    async rebuildThumbnails() {
      if (!thumbnailer) return 0;
      const rows = await db.all("SELECT id, file_path, file_type FROM documents WHERE thumb_path IS NULL AND is_demo = 0 AND file_path IS NOT NULL;");
      let made = 0;
      for (const r of rows) {
        if (!IMAGE_TYPES.has(r.file_type) || !(await storage.exists(r.file_path))) continue;
        try {
          const thumb = await withTimeout(thumbnailer(await storage.readBase64(r.file_path), SUPPORTED_TYPES[r.file_type]), THUMB_TIMEOUT_MS);
          if (!thumb) continue;
          const base = r.file_path.slice(DOCS_DIR.length + 1).replace(/\.[^.]+$/, '');
          const thumbPath = `${THUMBS_DIR}/${base}.jpg`;
          await storage.write(thumbPath, thumb);
          await db.transaction(() => db.run('UPDATE documents SET thumb_path = ? WHERE id = ?;', [thumbPath, r.id]));
          made++;
        } catch { /* best effort: a missing thumbnail only means the icon is shown */ }
      }
      return made;
    },

    /** Removes orphan files (e.g. from interrupted imports) and reports records with missing files. */
    /** MyDocs ships without sample documents: removes the built-in sample entries (is_demo) that earlier versions created. Real documents are never touched. */
    async removeSamples() {
      await db.run('DELETE FROM documents WHERE is_demo = 1;');
    },

    async reconcile() {
      const known = new Set((await db.all('SELECT file_path FROM documents WHERE file_path IS NOT NULL;')).map((r) => r.file_path));
      let orphansRemoved = 0;
      for (const f of await storage.list(DOCS_DIR)) {
        const path = `${DOCS_DIR}/${f}`;
        if (!known.has(path)) { await storage.remove(path).catch(() => {}); orphansRemoved++; }
      }
      await storage.clearShareCache?.().catch(() => {}); // drop the temporary copy from the last share
      const knownThumbs = new Set((await db.all('SELECT thumb_path FROM documents WHERE thumb_path IS NOT NULL;')).map((r) => r.thumb_path));
      for (const f of await storage.list(THUMBS_DIR)) {
        const path = `${THUMBS_DIR}/${f}`;
        if (!knownThumbs.has(path)) await storage.remove(path).catch(() => {});
      }
      const missing = (await service.list()).filter((d) => d.missing).map((d) => d.id);
      return { orphansRemoved, missing };
    },
  };
  return service;
}

/** Keep counting (without keeping data) up to this many bytes when a provider reports no size, so the message can show a real size. */
const COUNT_CAP_BYTES = 100 * MB;

/**
 * Reads a file through its WebView URL but never holds more than `maxBytes` in memory. Resolves with
 * { data(base64), size } or, when the file is bigger than allowed, { tooLarge: true, size, atLeast }.
 */
export async function readLimited(url, maxBytes, fetchImpl = globalThis.fetch) {
  let response;
  try { response = await fetchImpl(url); } catch { throw new DocumentError('FILE_READ_FAILED', 'The selected file could not be read. Please try again or choose another file.'); }
  if (!response?.ok) throw new DocumentError('FILE_READ_FAILED', 'The selected file could not be read. Please try again or choose another file.');
  const declared = Number(response.headers?.get?.('content-length')) || 0;
  const reader = response.body?.getReader?.();
  if (declared > maxBytes) { await reader?.cancel?.().catch?.(() => {}); return { tooLarge: true, size: declared }; }
  try {
    if (!reader) { // no streaming support: the blob size is known before it is encoded
      const blob = await response.blob();
      return blob.size > maxBytes ? { tooLarge: true, size: blob.size } : { data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), size: blob.size };
    }
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total <= maxBytes) { chunks.push(value); continue; }
      chunks.length = 0; // over the limit: stop keeping data, only count
      if (total > COUNT_CAP_BYTES) { await reader.cancel(); return { tooLarge: true, size: total, atLeast: true }; }
    }
    if (total > maxBytes) return { tooLarge: true, size: total };
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength; }
    return { data: bytesToBase64(bytes), size: total };
  } catch (e) {
    if (e instanceof DocumentError) throw e;
    throw new DocumentError('FILE_READ_FAILED', 'The selected file could not be read. Please try again or choose another file.');
  }
}

/** Native adapters (Capacitor). Used only on device. */
export function capacitorAdapters(plugins = globalThis.Capacitor?.Plugins, external = (fn) => fn()) {
  // `external` wraps every call that opens an Android screen of our own (picker, viewer, share sheet, camera) so
  // App Lock does not treat leaving the app for that screen as the user walking away.
  const fs = plugins?.Filesystem;
  const directory = 'DATA'; // app-private; not encrypted by the app
  const isMissing = (e) => /not exist|not found|ENOENT/i.test(String(e?.message ?? e));
  const storage = {
    async write(path, data) { await fs.writeFile({ path, data, directory, recursive: true }); },
    async remove(path) { await fs.deleteFile({ path, directory }); },
    async exists(path) {
      try { await fs.stat({ path, directory }); return true; } catch (e) { if (isMissing(e)) return false; throw e; }
    },
    async list(dir) {
      try { return (await fs.readdir({ path: dir, directory })).files.map((f) => f.name ?? f); } catch (e) { if (isMissing(e)) return []; throw e; }
    },
    async uri(path) { return (await fs.getUri({ path, directory })).uri; },
    async src(path) { return globalThis.Capacitor.convertFileSrc(await storage.uri(path)); },
    async clearShareCache() {
      try { await fs.rmdir({ path: SHARE_DIR, directory: 'CACHE', recursive: true }); } catch (e) { if (!isMissing(e)) throw e; }
    },
    async readBase64(path) { return (await fs.readFile({ path, directory })).data; },
    /** Starts a new temporary file in cache/share (any previous one is removed first). */
    async beginShareFile(fileName) {
      await storage.clearShareCache();
      await fs.mkdir({ path: SHARE_DIR, directory: 'CACHE', recursive: true });
      await fs.writeFile({ path: `${SHARE_DIR}/${fileName}`, data: '', directory: 'CACHE', encoding: 'utf8' });
    },
    async appendShareFile(fileName, base64) { await fs.appendFile({ path: `${SHARE_DIR}/${fileName}`, data: base64, directory: 'CACHE' }); },
    async shareFileUri(fileName) { return (await fs.getUri({ path: `${SHARE_DIR}/${fileName}`, directory: 'CACHE' })).uri; },
    /** Copies a stored file to cache/share/<fileName> (one temporary copy at a time) and returns its file URI. */
    async stageForShare(path, fileName) {
      await storage.clearShareCache();
      await fs.mkdir({ path: SHARE_DIR, directory: 'CACHE', recursive: true });
      const to = `${SHARE_DIR}/${fileName}`;
      await fs.copy({ from: path, directory, to, toDirectory: 'CACHE' });
      return (await fs.getUri({ path: to, directory: 'CACHE' })).uri;
    },
  };
  const picker = plugins?.FilePicker && {
    /**
     * Opens the system picker (Storage Access Framework) WITHOUT reading the file. The result carries the size the provider
     * reports (0 = unknown) and a read() that streams the content through the WebView's content:// bridge, so no filesystem
     * path is needed and the original file is only ever read, never changed.
     */
    async pick() {
      let files;
      try {
        ({ files } = await external(() => plugins.FilePicker.pickFiles({ limit: 1, readData: false, types: [...new Set(Object.values(SUPPORTED_TYPES))] })));
      } catch (e) {
        if (/cancel/i.test(String(e?.message ?? e))) return null;
        throw e;
      }
      const f = files?.[0];
      if (!f) return null;
      const url = f.webPath || (f.path ? globalThis.Capacitor.convertFileSrc(f.path) : '');
      return {
        name: f.name, mimeType: f.mimeType,
        size: Number(f.size) > 0 ? Number(f.size) : 0,
        read: ({ maxBytes }) => readLimited(url, maxBytes),
      };
    },
  };
  const viewer = plugins?.FileViewer && {
    open: (uri) => external(() => plugins.FileViewer.openDocumentFromLocalPath({ path: uri })),
  };
  const sharePlugin = plugins?.Share;
  const sharer = sharePlugin && {
    async share({ uri, title }) {
      try {
        // The plugin builds an ACTION_SEND intent with a FileProvider content:// URI, grants temporary read access and shows the chooser.
        await external(() => sharePlugin.share({ files: [uri], title, dialogTitle: 'Share document' }));
        return true;
      } catch (e) {
        const text = String(e?.message ?? e);
        if (/cancel/i.test(text)) return false;
        if (/in progress/i.test(text)) return false; // a share sheet is already open
        if (/No Activity found|ActivityNotFound/i.test(text)) throw new DocumentError('NO_SHARE_TARGET', 'No app on this device can receive this file.');
        if (/Failed to find configured root|fileprovider|FileProvider/i.test(text)) throw new DocumentError('SHARE_CONFIG', 'Sharing is not set up correctly for this file.');
        throw new DocumentError('SHARE_FAILED', 'Could not open the share sheet. Please try again.');
      }
    },
  };
  const cam = plugins?.Camera;
  const camera = cam && {
    async capture() {
      let res = null;
      /** Removes the temporary image the camera left behind (best effort; also when it is rejected). */
      const discard = async () => { const p = res?.uri ?? res?.path; if (p && plugins.Filesystem) await plugins.Filesystem.deleteFile({ path: p }).catch(() => {}); };
      try {
        // Uses the system camera app (no CAMERA permission is declared, so none is requested).
        res = await external(() => cam.takePhoto({ quality: 90, targetWidth: 2400, targetHeight: 2400, correctOrientation: true, encodingType: 0, saveToGallery: false }));
        const url = res.webPath ?? res.uri;
        if (!url) throw new DocumentError('CAPTURE_FAILED', 'The camera did not return a photo.');
        const blob = await (await fetch(globalThis.Capacitor.convertFileSrc(url))).blob();
        enforceSize(blob.size, 'capture'); // the real size of the final image, before it is encoded or kept anywhere
        const data = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
        await discard(); // the image now lives only in memory until the user saves it
        return { mimeType: 'image/jpeg', data };
      } catch (e) {
        await discard();
        if (e instanceof DocumentError) throw e;
        const text = `${e?.code ?? ''} ${e?.message ?? e}`;
        if (/0006|cancel/i.test(text)) return null; // user backed out of the camera
        if (/0003|permission|denied/i.test(text)) throw new DocumentError('CAMERA_DENIED', 'Camera access was denied. Allow camera access for MyDocs in Android Settings, then try again.');
        if (/0007|no camera|unavailable/i.test(text)) throw new DocumentError('CAMERA_UNAVAILABLE', 'No camera is available on this device.');
        throw new DocumentError('CAPTURE_FAILED', 'Could not capture the photo. Please try again.');
      }
    },
  };
  return { storage, picker, viewer, camera, sharer };
}
