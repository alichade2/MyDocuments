// SQLite access layer. Platform specifics live in drivers; the rest of the app
// only sees createDatabase(driver) -> { init, all, run, transaction, close }.

export const DB_NAME = 'mydocs';
import { CATEGORIES, LEGACY_NAMES, CUSTOM_ORDER_BASE, demoDocuments } from './seed.js';

export const SCHEMA_VERSION = 5;
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
  // v3: optional thumbnail file for image documents.
  `ALTER TABLE documents ADD COLUMN thumb_path TEXT;`,
  // v4: user-created categories. is_custom marks them (built-in ones stay permanent); names are unique ignoring case.
  `ALTER TABLE categories ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0;
   CREATE UNIQUE INDEX idx_categories_name_nocase ON categories(name COLLATE NOCASE);`,
  // v5: user categories sort after every built-in one, whatever built-ins later versions add (see CUSTOM_ORDER_BASE).
  `UPDATE categories SET sort_order = sort_order + ${CUSTOM_ORDER_BASE} WHERE is_custom = 1 AND sort_order < ${CUSTOM_ORDER_BASE};`,
];

// Categories are upserted by stable slug on every launch (idempotent); v1 rows are adopted by name.
async function seedCategories(driver, { checkCustomClashes = true } = {}) {
  for (const c of CATEGORIES) {
    await driver.run('UPDATE categories SET slug = ? WHERE slug IS NULL AND name = ?;', [c.slug, c.name]);
  }
  for (const [name, slug] of Object.entries(LEGACY_NAMES)) {
    await driver.run('UPDATE categories SET slug = ? WHERE slug IS NULL AND name = ?;', [slug, name]);
  }
  // A user category that already uses a built-in name (e.g. someone created "Agricultural Documents" before it
  // became built-in) is renamed, not deleted, so the built-in row can be inserted and no documents are lost.
  for (const c of checkCustomClashes ? CATEGORIES : []) { // (the v2 migration runs before is_custom exists; there are no custom rows yet)
    const clashes = await driver.all('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND is_custom = 1 AND slug <> ?;', [c.name, c.slug]);
    for (const row of clashes) {
      let n = 0;
      let candidate;
      do {
        n += 1;
        candidate = `${c.name} (custom${n > 1 ? ` ${n}` : ''})`;
      } while ((await driver.all('SELECT id FROM categories WHERE name = ? COLLATE NOCASE;', [candidate])).length);
      await driver.run('UPDATE categories SET name = ? WHERE id = ?;', [candidate, row.id]);
    }
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

/** @param {{seedSamples?: boolean}} [options] the app passes seedSamples:false (no sample documents); the default keeps the sample fixtures the tests rely on */
export function createDatabase(driver, { seedSamples = true } = {}) {
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
          await seedCategories(driver, { checkCustomClashes: false });
          if (seedSamples) await seedDemoDocuments(driver);
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

  /** Runs `fn` after every queued transaction and before the next one, so it sees a stable database. */
  function exclusive(fn) {
    const job = queue.then(fn);
    queue = job.catch(() => {});
    return job;
  }

  return {
    init() { return (ready ??= migrate().catch((e) => { ready = null; throw e; })); },
    all: (sql, params = []) => driver.all(sql, params),
    run: (sql, params = []) => driver.run(sql, params),
    transaction,
    exclusive,
    /**
     * A consistent copy of the whole database as one SQLite file (VACUUM INTO: includes everything still in the WAL,
     * does not change the live database). Resolves with { data: base64, size }.
     */
    snapshot() {
      if (!driver.snapshot) throw new Error('This database driver cannot create snapshots.');
      return exclusive(() => driver.snapshot());
    },
    /**
     * Opens a SQLite file (base64) next to the live database as schema `bk` (read it with `bk.<table>` in queries).
     * Call detach() when finished. The file is never used as the live database.
     */
    async attach(data) {
      if (!driver.attach) throw new Error('This database driver cannot attach databases.');
      return driver.attach(data);
    },
    /** Makes sure every built-in category exists (also used inside a restore transaction). */
    reseed: () => seedCategories(driver),
    close: () => driver.close(),
  };
}

/** Driver backed by @capacitor-community/sqlite (native Android/iOS). */
export function capacitorSqliteDriver(plugin = globalThis.Capacitor?.Plugins?.CapacitorSQLite, fs = globalThis.Capacitor?.Plugins?.Filesystem) {
  if (!plugin) throw new Error('CapacitorSQLite plugin is not available (native platform required).');
  const database = DB_NAME;
  return {
    async open() {
      // isConnection() is a JS-wrapper method, not a native one; a repeat createConnection just reports "already exists".
      try {
        await plugin.createConnection({ database, version: 1, encrypted: false, mode: 'no-encryption', readonly: false });
      } catch (e) {
        if (!/already exist/i.test(String(e?.message ?? e))) throw e;
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
    async snapshot() { return nativeFiles(fs).snapshot(plugin, database); },
    async attach(data) { return nativeFiles(fs).attach(plugin, database, data); },
  };
}

/** Temporary SQLite files in the app's cache folder (never the app's real database files). */
function nativeFiles(fs) {
  if (!fs) throw new Error('Filesystem plugin is not available.');
  const dir = 'backup-tmp';
  const sqlPath = async (name) => {
    await fs.mkdir({ path: dir, directory: 'CACHE', recursive: true }).catch(() => {});
    const { uri } = await fs.getUri({ path: `${dir}/${name}`, directory: 'CACHE' });
    return { rel: `${dir}/${name}`, abs: uri.replace(/^file:\/\//, '') };
  };
  const quote = (path) => `'${path.replace(/'/g, "''")}'`;
  return {
    async snapshot(plugin, database) {
      const f = await sqlPath('snapshot.sqlite');
      await fs.deleteFile({ path: f.rel, directory: 'CACHE' }).catch(() => {});
      try {
        await plugin.execute({ database, statements: `VACUUM INTO ${quote(f.abs)};`, transaction: false });
        const { data } = await fs.readFile({ path: f.rel, directory: 'CACHE' });
        return { data, size: Math.floor((data.length * 3) / 4) };
      } finally {
        await fs.deleteFile({ path: f.rel, directory: 'CACHE' }).catch(() => {});
      }
    },
    async attach(plugin, database, data) {
      const f = await sqlPath('incoming.sqlite');
      await fs.writeFile({ path: f.rel, directory: 'CACHE', data, recursive: true });
      try {
        await plugin.execute({ database, statements: `ATTACH DATABASE ${quote(f.abs)} AS bk;`, transaction: false });
      } catch (e) {
        await fs.deleteFile({ path: f.rel, directory: 'CACHE' }).catch(() => {});
        throw e;
      }
      return {
        async detach() {
          try { await plugin.execute({ database, statements: 'DETACH DATABASE bk;', transaction: false }); } finally {
            await fs.deleteFile({ path: f.rel, directory: 'CACHE' }).catch(() => {});
          }
        },
      };
    },
  };
}

export function isNativePlatform() {
  return Boolean(globalThis.Capacitor?.isNativePlatform?.());
}
