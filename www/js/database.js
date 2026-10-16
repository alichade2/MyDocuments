// SQLite access layer. Platform specifics live in drivers; the rest of the app
// only sees createDatabase(driver) -> { init, all, run, transaction, close }.

export const DB_NAME = 'mydocs';
import { CATEGORIES, LEGACY_NAMES, demoDocuments } from './seed.js';

export const SCHEMA_VERSION = 2;
export const DEFAULT_CATEGORIES = CATEGORIES.map((c) => c.name);

const MIGRATIONS = [
  // v1
  `CREATE TABLE categories (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL UNIQUE,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   );
   CREATE TABLE documents (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
     name TEXT NOT NULL CHECK (length(trim(name)) > 0),
     original_filename TEXT NOT NULL,
     file_type TEXT NOT NULL,
     mime_type TEXT,
     file_path TEXT NOT NULL UNIQUE,
     file_size INTEGER NOT NULL CHECK (file_size >= 0),
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     expiry_date TEXT
   );
   CREATE INDEX idx_documents_category ON documents(category_id);
   CREATE INDEX idx_documents_name ON documents(name);`,
  // v2: category slug/icon/sort_order; documents get is_demo + seed_key and nullable file_path/file_size.
  `ALTER TABLE categories ADD COLUMN slug TEXT;
   CREATE UNIQUE INDEX idx_categories_slug ON categories(slug);
   ALTER TABLE categories ADD COLUMN icon TEXT;
   ALTER TABLE categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE documents_new (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
     name TEXT NOT NULL CHECK (length(trim(name)) > 0),
     original_filename TEXT NOT NULL,
     file_type TEXT NOT NULL,
     mime_type TEXT,
     file_path TEXT UNIQUE,
     file_size INTEGER CHECK (file_size IS NULL OR file_size >= 0),
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     expiry_date TEXT,
     is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
     seed_key TEXT UNIQUE,
     CHECK (is_demo = 1 OR file_path IS NOT NULL)
   );
   INSERT INTO documents_new (id, category_id, name, original_filename, file_type, mime_type, file_path, file_size, created_at, updated_at, expiry_date)
     SELECT id, category_id, name, original_filename, file_type, mime_type, file_path, file_size, created_at, updated_at, expiry_date FROM documents;
   DROP TABLE documents;
   ALTER TABLE documents_new RENAME TO documents;
   CREATE INDEX idx_documents_category ON documents(category_id);
   CREATE INDEX idx_documents_name ON documents(name);`,
];

// Categories are upserted by stable slug on every launch (idempotent); v1 rows are adopted by name.
async function seedCategories(driver) {
  for (const c of CATEGORIES) {
    await driver.run('UPDATE categories SET slug = ? WHERE slug IS NULL AND name = ?;', [c.slug, c.name]);
  }
  for (const [name, slug] of Object.entries(LEGACY_NAMES)) {
    await driver.run('UPDATE categories SET slug = ? WHERE slug IS NULL AND name = ?;', [slug, name]);
  }
  for (const [i, c] of CATEGORIES.entries()) {
    await driver.run(
      `INSERT INTO categories (slug, name, icon, sort_order) VALUES (?,?,?,?)
       ON CONFLICT(slug) DO UPDATE SET name = excluded.name, icon = excluded.icon, sort_order = excluded.sort_order;`,
      [c.slug, c.name, c.icon, i + 1]);
  }
}

// Demo metadata is inserted once, inside the v2 migration, so documents the user deletes stay deleted.
async function seedDemoDocuments(driver) {
  for (const d of demoDocuments()) {
    await driver.run(
      `INSERT OR IGNORE INTO documents (category_id, name, original_filename, file_type, mime_type, file_path, file_size, created_at, updated_at, is_demo, seed_key)
       VALUES ((SELECT id FROM categories WHERE slug = ?), ?, ?, 'pdf', 'application/pdf', NULL, NULL, ?, ?, 1, ?);`,
      [d.categorySlug, d.name, d.filename, d.ts, d.ts, d.seedKey]);
  }
}

export function createDatabase(driver) {
  let ready = null;

  async function migrate() {
    await driver.open();
    await driver.exec('PRAGMA foreign_keys = ON;');
    const rows = await driver.all('PRAGMA user_version;');
    let version = Number(rows[0]?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      throw new Error(`Database schema v${version} is newer than this app supports (v${SCHEMA_VERSION}).`);
    }
    while (version < SCHEMA_VERSION) {
      const next = version + 1;
      await transaction(async () => {
        await driver.exec(MIGRATIONS[version]);
        if (next === 2) {
          await seedCategories(driver);
          await seedDemoDocuments(driver);
        }
        await driver.exec(`PRAGMA user_version = ${next};`);
      });
      version = next;
    }
    await seedCategories(driver);
  }

  // Transactions are serialised: a single connection must not interleave them.
  let queue = Promise.resolve();
  function transaction(fn) {
    const job = queue.then(async () => {
      await driver.begin();
      try {
        const result = await fn();
        await driver.commit();
        return result;
      } catch (err) {
        try { await driver.rollback(); } catch { /* keep original error */ }
        throw err;
      }
    });
    queue = job.catch(() => {});
    return job;
  }

  return {
    init() { return (ready ??= migrate().catch((e) => { ready = null; throw e; })); },
    all: (sql, params = []) => driver.all(sql, params),
    run: (sql, params = []) => driver.run(sql, params),
    transaction,
    close: () => driver.close(),
  };
}

/** Driver backed by @capacitor-community/sqlite (native Android/iOS). */
export function capacitorSqliteDriver(plugin = globalThis.Capacitor?.Plugins?.CapacitorSQLite) {
  if (!plugin) throw new Error('CapacitorSQLite plugin is not available (native platform required).');
  const database = DB_NAME;
  return {
    async open() {
      const { result } = await plugin.isConnection({ database, readonly: false }).catch(() => ({ result: false }));
      if (!result) {
        await plugin.createConnection({ database, version: 1, encrypted: false, mode: 'no-encryption', readonly: false });
      }
      await plugin.open({ database, readonly: false });
    },
    exec: (sql) => plugin.execute({ database, statements: sql, transaction: false }),
    run: (statement, values) => plugin.run({ database, statement, values, transaction: false }),
    all: async (statement, values = []) => (await plugin.query({ database, statement, values })).values ?? [],
    begin: () => plugin.beginTransaction({ database }),
    commit: () => plugin.commitTransaction({ database }),
    rollback: () => plugin.rollbackTransaction({ database }),
    async close() {
      await plugin.closeConnection({ database, readonly: false });
    },
  };
}

export function isNativePlatform() {
  return Boolean(globalThis.Capacitor?.isNativePlatform?.());
}
