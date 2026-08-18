import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

export type DB = Database.Database;

/**
 * Opens (creating if needed) the SQLite database at dbPath and applies any
 * pending migrations from db/migrations/*.sql in filename order, tracked via
 * a schema_migrations table. Idempotent: safe to call on every startup.
 */
export function openDatabase(dbPath: string): DB {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function runMigrations(db: DB): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db
      .prepare("SELECT id FROM schema_migrations")
      .all()
      .map((row) => (row as { id: string }).id)
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (id) VALUES (?)"
  );

  const pending = files.filter((file) => !applied.has(file));
  if (pending.length === 0) return;

  // Some migrations rebuild a table (SQLite has no ALTER COLUMN to relax a
  // NOT NULL constraint — e.g. migration 006's patch table rebuild) via the
  // standard create-new/copy/drop-old/rename pattern. With foreign_keys ON,
  // dropping a table that another table's FK references (e.g. patch_review
  // -> patch) cascade-deletes the referencing rows before the rename ever
  // happens — a real bug this project's migration-upgrade safety check
  // caught for migration 006. `PRAGMA foreign_keys` can only be changed
  // outside a transaction, so it's toggled once around the whole batch of
  // pending migrations, not per-file.
  db.pragma("foreign_keys = OFF");
  try {
    for (const file of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
      const applyMigration = db.transaction(() => {
        db.exec(sql);
        insertMigration.run(file);
      });
      applyMigration();
    }
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
