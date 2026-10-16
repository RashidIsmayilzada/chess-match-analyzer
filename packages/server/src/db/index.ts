/**
 * Database bootstrap: opens the SQLite file, applies pragmas and the boot-time migration,
 * and returns a Drizzle instance typed with the schema.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from './migrate.js';
import { schema } from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenedDatabase {
  sqlite: Database.Database;
  db: Db;
  close(): void;
}

export const MEMORY_DB = ':memory:';

export function openDatabase(dbPath: string): OpenedDatabase {
  const inMemory = dbPath === MEMORY_DB;
  if (!inMemory) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  if (!inMemory) sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  migrate(sqlite);
  const db = drizzle(sqlite, { schema });
  return {
    sqlite,
    db,
    close: () => {
      if (sqlite.open) sqlite.close();
    },
  };
}

export { schema };
export * from './schema.js';
