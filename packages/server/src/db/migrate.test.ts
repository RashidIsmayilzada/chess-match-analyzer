import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { hasColumn, migrate } from './migrate.js';

describe('migrate', () => {
  it('backfills game_profiles for databases created before the link table existed', () => {
    const sqlite = new Database(':memory:');
    // Old schema: games only know their owner.
    sqlite.exec(`
      CREATE TABLE profiles (username TEXT PRIMARY KEY, last_sync INTEGER, created_at TEXT NOT NULL);
      CREATE TABLE games (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, profile_username TEXT NOT NULL REFERENCES profiles(username),
        time_class TEXT NOT NULL, time_control TEXT NOT NULL, rated INTEGER NOT NULL, end_time INTEGER NOT NULL,
        white_username TEXT NOT NULL, white_rating INTEGER NOT NULL, white_result TEXT NOT NULL,
        black_username TEXT NOT NULL, black_rating INTEGER NOT NULL, black_result TEXT NOT NULL,
        result TEXT NOT NULL, pgn TEXT NOT NULL, eco TEXT, opening_name TEXT, imported_at TEXT NOT NULL
      );
      INSERT INTO profiles VALUES ('alice', NULL, 't0');
      INSERT INTO games VALUES ('g1', 'u', 'alice', 'blitz', '300', 1, 1, 'alice', 1, 'win', 'bob', 1, 'resigned', '1-0', '', NULL, NULL, 't1');
    `);
    migrate(sqlite);
    migrate(sqlite); // idempotent
    const links = sqlite.prepare('SELECT game_id, profile_username, imported_at FROM game_profiles').all();
    expect(links).toEqual([{ game_id: 'g1', profile_username: 'alice', imported_at: 't1' }]);
    sqlite.close();
  });

  it('rebuilds position_analyses with movetime_ms in the primary key, keeping old rows as movetime 0', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE position_analyses (
        fen TEXT NOT NULL, depth INTEGER NOT NULL, multipv INTEGER NOT NULL, engine TEXT NOT NULL,
        lines_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (fen, depth, multipv, engine)
      );
      INSERT INTO position_analyses VALUES ('f', 18, 3, 'SF', '[]', 't0');
    `);
    expect(hasColumn(sqlite, 'position_analyses', 'movetime_ms')).toBe(false);
    migrate(sqlite);
    migrate(sqlite); // idempotent
    expect(hasColumn(sqlite, 'position_analyses', 'movetime_ms')).toBe(true);
    expect(sqlite.prepare('SELECT fen, depth, movetime_ms FROM position_analyses').all()).toEqual([{ fen: 'f', depth: 18, movetime_ms: 0 }]);
    // Same fen/depth/multipv/engine under a different movetime is a distinct row.
    sqlite.prepare("INSERT INTO position_analyses VALUES ('f', 18, 3, 'SF', 200, '[]', 't1')").run();
    expect(sqlite.prepare('SELECT count(*) AS n FROM position_analyses').get()).toEqual({ n: 2 });
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'position_analyses_old'").get()).toBeUndefined();
    sqlite.close();
  });
});
