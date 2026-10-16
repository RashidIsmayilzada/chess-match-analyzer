/**
 * Boot-time schema migration: idempotent CREATE TABLE IF NOT EXISTS statements.
 * Keep in sync with ./schema.ts.
 */
import type Database from 'better-sqlite3';

export const MIGRATION_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS profiles (
    username TEXT PRIMARY KEY,
    last_sync INTEGER,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS games (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    profile_username TEXT NOT NULL REFERENCES profiles(username),
    time_class TEXT NOT NULL,
    time_control TEXT NOT NULL,
    rated INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    white_username TEXT NOT NULL,
    white_rating INTEGER NOT NULL,
    white_result TEXT NOT NULL,
    black_username TEXT NOT NULL,
    black_rating INTEGER NOT NULL,
    black_result TEXT NOT NULL,
    result TEXT NOT NULL,
    pgn TEXT NOT NULL,
    eco TEXT,
    opening_name TEXT,
    imported_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS games_profile_end_time_idx ON games(profile_username, end_time)`,
  `CREATE INDEX IF NOT EXISTS games_time_class_idx ON games(time_class)`,
  `CREATE TABLE IF NOT EXISTS game_profiles (
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    profile_username TEXT NOT NULL REFERENCES profiles(username),
    imported_at TEXT NOT NULL,
    PRIMARY KEY (game_id, profile_username)
  )`,
  `CREATE INDEX IF NOT EXISTS game_profiles_profile_idx ON game_profiles(profile_username)`,
  // Databases created before game_profiles existed: link every game to its owner.
  `INSERT OR IGNORE INTO game_profiles (game_id, profile_username, imported_at)
    SELECT id, profile_username, imported_at FROM games`,
  `CREATE TABLE IF NOT EXISTS position_analyses (
    fen TEXT NOT NULL,
    depth INTEGER NOT NULL,
    multipv INTEGER NOT NULL,
    engine TEXT NOT NULL,
    lines_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (fen, depth, multipv, engine)
  )`,
  `CREATE TABLE IF NOT EXISTS game_analyses (
    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    settings_key TEXT NOT NULL,
    analysis_json TEXT NOT NULL,
    analyzed_at TEXT NOT NULL,
    PRIMARY KEY (game_id, settings_key)
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL,
    progress REAL NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at)`,
];

export function migrate(sqlite: Database.Database): void {
  const run = sqlite.transaction(() => {
    for (const statement of MIGRATION_STATEMENTS) sqlite.exec(statement);
  });
  run();
}
