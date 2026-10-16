// Document service: coordinates SQLite metadata with files in app-private storage.
// Storage / picker / viewer are injected adapters so no native API reaches the UI.

export const DOCS_DIR = 'documents';
export const THUMBS_DIR = 'thumbnails'; // outside DOCS_DIR so reconcile can sweep each independently
export const IMAGE_TYPES = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
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

export function extensionOf(filename) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(filename ?? ''));
  return m ? m[1].toLowerCase() : '';
}

/** Suggested display name for a picked file: filename without its extension, trimmed to the max length. */
export function suggestName(filename) {
  const base = String(filename ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/\s+/g, ' ').trim();
  return base.slice(0, MAX_NAME_LENGTH);
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
 * @param {Function} [deps.thumbnailer] async (base64, mimeType) -> base64 JPEG thumbnail | null
 */
export function createDocumentService({ db, storage, picker, viewer, camera, thumbnailer, now = () => new Date().toISOString(), uuid = () => crypto.randomUUID() }) {
  async function requireCategory(categoryId) {
    const rows = await db.all('SELECT id FROM categories WHERE id = ?;', [categoryId]);
    if (!rows.length) throw new DocumentError('INVALID_CATEGORY', 'Unknown category.');
  }
  async function getRow(id) {
    const rows = await db.all('SELECT * FROM documents WHERE id = ?;', [id]);
    if (!rows.length) throw new DocumentError('NOT_FOUND', 'Document not found.');
    return rows[0];
  }

  const service = {
    async listCategories() {
      return db.all('SELECT id, slug, name, icon, sort_order FROM categories ORDER BY sort_order, id;');
    },

    /** Documents of a category (all when categoryId is omitted); flags records whose file is gone. */
    async list(categoryId) {
      const rows = categoryId == null
        ? await db.all('SELECT * FROM documents ORDER BY name COLLATE NOCASE, id;')
        : await db.all('SELECT * FROM documents WHERE category_id = ? ORDER BY name COLLATE NOCASE, id;', [categoryId]);
      return Promise.all(rows.map(async (r) => ({ ...toRecord(r), missing: r.is_demo !== 1 && !(await storage.exists(r.file_path)) })));
    },

    async get(id) { return toRecord(await getRow(id)); },

    /** file: { name, mimeType, size, data(base64) } */
    async importFile(categoryId, file, displayName) {
      await requireCategory(categoryId);
      const ext = extensionOf(file?.name);
      if (!SUPPORTED_TYPES[ext]) throw new DocumentError('UNSUPPORTED_TYPE', `Unsupported file type ".${ext || '?'}".`);
      if (!file.data) throw new DocumentError('EMPTY_FILE', 'The selected file has no content.');
      if (file.size > MAX_FILE_BYTES) throw new DocumentError('TOO_LARGE', 'File is larger than 25 MB.');
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
        await db.transaction(() => db.run(
          `INSERT INTO documents (category_id, name, original_filename, file_type, mime_type, file_path, file_size, created_at, updated_at, thumb_path)
           VALUES (?,?,?,?,?,?,?,?,?,?);`,
          [categoryId, name, file.name, ext, SUPPORTED_TYPES[ext], filePath, file.size ?? 0, ts, ts, thumbPath]));
      } catch (err) {
        await storage.remove(filePath).catch(() => {}); // keep file system and DB consistent
        if (thumbPath) await storage.remove(thumbPath).catch(() => {});
        throw err;
      }
      const rows = await db.all('SELECT * FROM documents WHERE file_path = ?;', [filePath]);
      return toRecord(rows[0]);
    },

    /** Step 1 of the upload flow: let the user pick a file. Returns null when cancelled. */
    async pickFile() {
      if (!picker) throw new DocumentError('NO_PICKER', 'File picking is not available on this platform.');
      return (await picker.pick()) ?? null;
    },

    /** Camera capture (step 1 of the capture flow). Returns a file-like object, or null when cancelled. */
    async capturePhoto() {
      if (!camera) throw new DocumentError('NO_CAMERA', 'The camera is not available on this platform.');
      const shot = await camera.capture();
      if (!shot) return null;
      const d = new Date(now());
      const p = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      const padding = (shot.data.match(/=+$/) ?? [''])[0].length;
      return { name: `Captured_${stamp}.jpg`, mimeType: 'image/jpeg', size: Math.floor((shot.data.length * 3) / 4) - padding, data: shot.data };
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

    async importFromPicker(categoryId) {
      if (!picker) throw new DocumentError('NO_PICKER', 'File picking is not available on this platform.');
      const file = await picker.pick();
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

    /** Removes orphan files (e.g. from interrupted imports) and reports records with missing files. */
    async reconcile() {
      const known = new Set((await db.all('SELECT file_path FROM documents WHERE file_path IS NOT NULL;')).map((r) => r.file_path));
      let orphansRemoved = 0;
      for (const f of await storage.list(DOCS_DIR)) {
        const path = `${DOCS_DIR}/${f}`;
        if (!known.has(path)) { await storage.remove(path).catch(() => {}); orphansRemoved++; }
      }
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

/** Native adapters (Capacitor). Used only on device. */
export function capacitorAdapters(plugins = globalThis.Capacitor?.Plugins) {
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
  };
  const picker = plugins?.FilePicker && {
    async pick() {
      try {
        const { files } = await plugins.FilePicker.pickFiles({ limit: 1, readData: true, types: [...new Set(Object.values(SUPPORTED_TYPES))] });
        const f = files?.[0];
        return f ? { name: f.name, mimeType: f.mimeType, size: f.size, data: f.data } : null;
      } catch (e) {
        if (/cancel/i.test(String(e?.message ?? e))) return null;
        throw e;
      }
    },
  };
  const viewer = plugins?.FileViewer && {
    open: (uri) => plugins.FileViewer.openDocumentFromLocalPath({ path: uri }),
  };
  const cam = plugins?.Camera;
  const camera = cam && {
    async capture() {
      try {
        // Uses the system camera app (no CAMERA permission is declared, so none is requested).
        const res = await cam.takePhoto({ quality: 90, targetWidth: 2400, targetHeight: 2400, correctOrientation: true, encodingType: 0, saveToGallery: false });
        const url = res.webPath ?? res.uri;
        if (!url) throw new DocumentError('CAPTURE_FAILED', 'The camera did not return a photo.');
        const blob = await (await fetch(globalThis.Capacitor.convertFileSrc(url))).blob();
        const data = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1]);
          r.onerror = () => reject(r.error);
          r.readAsDataURL(blob);
        });
        return { mimeType: 'image/jpeg', data };
      } catch (e) {
        if (e instanceof DocumentError) throw e;
        const text = `${e?.code ?? ''} ${e?.message ?? e}`;
        if (/0006|cancel/i.test(text)) return null; // user backed out of the camera
        if (/0003|permission|denied/i.test(text)) throw new DocumentError('CAMERA_DENIED', 'Camera access was denied. Allow camera access for MyDocs in Android Settings, then try again.');
        if (/0007|no camera|unavailable/i.test(text)) throw new DocumentError('CAMERA_UNAVAILABLE', 'No camera is available on this device.');
        throw new DocumentError('CAPTURE_FAILED', 'Could not capture the photo. Please try again.');
      }
    },
  };
  return { storage, picker, viewer, camera };
}
