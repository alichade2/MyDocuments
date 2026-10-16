// SQLite access layer. Platform specifics live in drivers; the rest of the app
// only sees createDatabase(driver) -> { init, all, run, transaction, close }.

export const DB_NAME = 'mydocs';
export const SCHEMA_VERSION = 1;
export const DEFAULT_CATEGORIES = ['Personal Documents', 'Educational Documents', 'IDs', 'Work Related Documents'];

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
];

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
        await driver.exec(`PRAGMA user_version = ${next};`);
      });
      version = next;
    }
    for (const name of DEFAULT_CATEGORIES) {
      await driver.run('INSERT OR IGNORE INTO categories (name) VALUES (?);', [name]);
    }
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
