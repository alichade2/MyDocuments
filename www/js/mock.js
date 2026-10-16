// Browser-preview only: in-memory repository with the same interface as the document service,
// seeded from the same demo data as SQLite. Nothing persists; never used on a native platform.
import { CATEGORIES, demoDocuments } from './seed.js';
import { DEMO_MESSAGE, DocumentError, validateName } from './documents.js';

export function createMockService() {
  const categories = CATEGORIES.map((c, i) => ({ id: i + 1, slug: c.slug, name: c.name, icon: c.icon, sort_order: i + 1 }));
  const idBySlug = new Map(categories.map((c) => [c.slug, c.id]));
  let nextId = 1;
  let docs = demoDocuments().map((d) => ({
    id: nextId++, categoryId: idBySlug.get(d.categorySlug), name: d.name, originalFilename: d.filename, fileType: 'pdf',
    mimeType: 'application/pdf', filePath: null, fileSize: null, createdAt: d.ts, updatedAt: d.ts, expiryDate: null, isDemo: true, missing: false,
  }));
  return {
    listCategories: async () => categories,
    list: async (categoryId) => docs.filter((d) => categoryId == null || d.categoryId === categoryId).map((d) => ({ ...d })),
    importFromPicker: async () => { throw new Error('Importing documents requires the Android app (browser preview only).'); },
    rename: async (id, name) => {
      const d = docs.find((x) => x.id === id);
      d.name = validateName(name);
      return { ...d };
    },
    remove: async (id) => { docs = docs.filter((d) => d.id !== id); },
    open: async () => { throw new DocumentError('DEMO_DOCUMENT', DEMO_MESSAGE); },
  };
}
