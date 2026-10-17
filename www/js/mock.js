// Browser-preview only: in-memory repository with the same interface as the document service,
// seeded from the same demo data as SQLite. Nothing persists; never used on a native platform.
import { CATEGORIES, demoDocuments } from './seed.js';
import { DEMO_MESSAGE, DocumentError, validateName, extensionOf, SUPPORTED_TYPES, IMAGE_TYPES } from './documents.js';
import { createThumbnail } from './images.js';
import { matchesDocument, normalizeQuery } from './search.js';

/** Draws a fake "photographed document" so the capture flow can be exercised without a camera. */
function fakePhoto(n) {
  const c = document.createElement('canvas');
  c.width = 600; c.height = 800;
  const g = c.getContext('2d');
  g.fillStyle = '#f5f1e6'; g.fillRect(0, 0, 600, 800);
  g.fillStyle = '#1f5fbf'; g.fillRect(0, 0, 600, 90);
  g.fillStyle = '#222'; g.font = '32px sans-serif'; g.fillText(`Sample capture #${n}`, 40, 170);
  for (let y = 230; y < 740; y += 40) g.fillRect(40, y, 400 + ((y * 7) % 120), 8);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}

export function createMockService() {
  const categories = CATEGORIES.map((c, i) => ({ id: i + 1, slug: c.slug, name: c.name, icon: c.icon, sort_order: i + 1 }));
  const idBySlug = new Map(categories.map((c) => [c.slug, c.id]));
  let nextId = 1;
  let shots = 0;
  const full = new Map(); // id -> data URL
  const thumbs = new Map();
  let docs = demoDocuments().map((d) => ({
    id: nextId++, categoryId: idBySlug.get(d.categorySlug), name: d.name, originalFilename: d.filename, fileType: 'pdf',
    mimeType: 'application/pdf', filePath: null, fileSize: null, createdAt: d.ts, updatedAt: d.ts, expiryDate: null, isDemo: true, missing: false, thumbPath: null,
  }));
  return {
    listCategories: async () => categories,
    list: async (categoryId) => docs.filter((d) => categoryId == null || d.categoryId === categoryId).map((d) => ({ ...d })),
    // Browser preview: stand-ins for the native picker and camera (no real file access).
    pickFile: async () => ({ name: `Sample_upload_${nextId}.pdf`, mimeType: 'application/pdf', size: 2048, data: 'QUJD' }),
    capturePhoto: async () => {
      const data = fakePhoto(++shots);
      return { name: `Captured_preview_${shots}.jpg`, mimeType: 'image/jpeg', size: Math.floor(data.length * 0.75), data };
    },
    importFile: async (categoryId, file, displayName) => {
      const ext = extensionOf(file?.name);
      if (!SUPPORTED_TYPES[ext]) throw new DocumentError('UNSUPPORTED_TYPE', `Unsupported file type ".${ext || '?'}".`);
      const name = validateName(displayName);
      const ts = new Date().toISOString();
      const id = nextId++;
      const doc = {
        id, categoryId, name, originalFilename: file.name, fileType: ext, mimeType: SUPPORTED_TYPES[ext], filePath: `mock/${id}.${ext}`,
        fileSize: file.size, createdAt: ts, updatedAt: ts, expiryDate: null, isDemo: false, missing: false, thumbPath: null,
      };
      if (IMAGE_TYPES.has(ext)) {
        full.set(id, `data:${SUPPORTED_TYPES[ext]};base64,${file.data}`);
        try { thumbs.set(id, `data:image/jpeg;base64,${await createThumbnail(file.data, SUPPORTED_TYPES[ext])}`); doc.thumbPath = `mock/thumb/${id}.jpg`; } catch { /* no thumbnail */ }
      }
      docs.push(doc);
      return { ...doc };
    },
    thumbnailSrc: async (doc) => thumbs.get(doc.id) ?? null,
    imageSrc: async (id) => {
      const d = docs.find((x) => x.id === id);
      if (d?.isDemo) throw new DocumentError('DEMO_DOCUMENT', DEMO_MESSAGE);
      return full.get(id);
    },
    search: async (query, { limit = 100 } = {}) => {
      const text = normalizeQuery(query).toLowerCase();
      const byId = new Map(categories.map((c) => [c.id, c]));
      return docs.filter((d) => matchesDocument(d, query))
        .sort((a, b) => (b.name.toLowerCase().startsWith(text) - a.name.toLowerCase().startsWith(text)) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id)
        .slice(0, limit)
        .map((d) => { const c = byId.get(d.categoryId); return { ...d, categoryName: c.name, categorySlug: c.slug, categoryIcon: c.icon }; });
    },
    shareDocument: async (id) => {
      const d = docs.find((x) => x.id === id);
      if (d?.isDemo) throw new DocumentError('DEMO_DOCUMENT', 'This is sample document data, so there is no file to share. Import a real document first.');
      throw new DocumentError('NO_SHARE', 'Sharing is only available in the Android app.');
    },
    rename: async (id, name) => {
      const d = docs.find((x) => x.id === id);
      d.name = validateName(name);
      return { ...d };
    },
    remove: async (id) => { docs = docs.filter((d) => d.id !== id); full.delete(id); thumbs.delete(id); },
    open: async () => { throw new DocumentError('DEMO_DOCUMENT', DEMO_MESSAGE); },
  };
}
