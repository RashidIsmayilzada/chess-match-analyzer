import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from './migrate.js';

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
});
