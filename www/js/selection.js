// Selection state keyed by unique document id (never by name), independent of rendering.

export function createSelection() {
  const ids = new Set();
  return {
    has: (id) => ids.has(id),
    get size() { return ids.size; },
    toList: () => [...ids],
    toggle(id, on = !ids.has(id)) { if (on) ids.add(id); else ids.delete(id); return on; },
    /** Select/deselect many ids at once (category-level checkbox). */
    setMany(list, on) { for (const id of list) { if (on) ids.add(id); else ids.delete(id); } },
    clear() { ids.clear(); },
    /** Drops ids that no longer exist (deleted documents). Returns how many were removed. */
    prune(validIds) {
      const valid = new Set(validIds);
      let removed = 0;
      for (const id of [...ids]) if (!valid.has(id)) { ids.delete(id); removed++; }
      return removed;
    },
    /** 'none' | 'some' | 'all' for a group of ids (drives the indeterminate category checkbox). */
    stateOf(list) {
      if (!list.length) return 'none';
      const n = list.reduce((c, id) => c + (ids.has(id) ? 1 : 0), 0);
      return n === 0 ? 'none' : n === list.length ? 'all' : 'some';
    },
  };
}
