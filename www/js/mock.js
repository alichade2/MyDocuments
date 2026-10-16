// Browser-preview only: in-memory stand-in with the same interface as the document service.
// Nothing here persists and it is never used on a native platform.

export function createMockService() {
  const categories = [
    { id: 1, name: 'Personal Documents' }, { id: 2, name: 'Educational Documents' },
    { id: 3, name: 'IDs' }, { id: 4, name: 'Work Related Documents' },
  ];
  const mk = (id, categoryId, name, fileType, fileSize) => ({
    id, categoryId, name, fileType, fileSize, missing: false, createdAt: '2026-01-15T10:00:00Z', expiryDate: null,
  });
  let docs = [
    mk(1, 1, 'Lease agreement', 'pdf', 482113),
    mk(2, 1, 'Medical notes', 'txt', 2048),
    mk(3, 2, 'Degree certificate', 'pdf', 912000),
    mk(4, 3, 'Passport scan', 'jpg', 1500000),
    mk(5, 3, 'Driver licence', 'png', 820000),
  ];
  let nextId = 6;
  const unsupported = (what) => { throw new Error(`${what} requires the Android app (browser preview only).`); };
  return {
    listCategories: async () => categories,
    list: async (categoryId) => docs.filter((d) => categoryId == null || d.categoryId === categoryId).map((d) => ({ ...d })),
    importFromPicker: async (categoryId) => {
      docs.push(mk(nextId++, categoryId, `Sample document ${nextId - 1}`, 'pdf', 10240));
      return docs.at(-1);
    },
    rename: async (id, name) => { const d = docs.find((x) => x.id === id); d.name = name.trim(); return d; },
    remove: async (id) => { docs = docs.filter((d) => d.id !== id); },
    open: async () => unsupported('Previewing documents'),
  };
}
