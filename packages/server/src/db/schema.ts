/**
 * Drizzle schema. Column names follow docs/ARCHITECTURE.md ("Database").
 * Timestamps are ISO-8601 strings unless documented as unix seconds.
 */
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const profiles = sqliteTable('profiles', {
  /** Lowercase chess.com username. */
  username: text('username').primaryKey(),
  /** Unix seconds of the last successful sync. */
  lastSync: integer('last_sync'),
  createdAt: text('created_at').notNull(),
});

export const games = sqliteTable(
  'games',
  {
    /** chess.com game uuid. */
    id: text('id').primaryKey(),
    url: text('url').notNull(),
    /** Profile that first imported the game (the owner); see `gameProfiles` for every profile. */
    profileUsername: text('profile_username')
      .notNull()
      .references(() => profiles.username),
    timeClass: text('time_class').notNull(),
    timeControl: text('time_control').notNull(),
    rated: integer('rated', { mode: 'boolean' }).notNull(),
    /** Unix seconds. */
    endTime: integer('end_time').notNull(),
    whiteUsername: text('white_username').notNull(),
    whiteRating: integer('white_rating').notNull(),
    whiteResult: text('white_result').notNull(),
    blackUsername: text('black_username').notNull(),
    blackRating: integer('black_rating').notNull(),
    blackResult: text('black_result').notNull(),
    /** PGN Result header: 1-0, 0-1, 1/2-1/2 or *. */
    result: text('result').notNull(),
    pgn: text('pgn').notNull(),
    eco: text('eco'),
    openingName: text('opening_name'),
    importedAt: text('imported_at').notNull(),
  },
  (t) => [
    index('games_profile_end_time_idx').on(t.profileUsername, t.endTime),
    index('games_time_class_idx').on(t.timeClass),
  ],
);

/**
 * Which profiles a game was imported for. A game played between two imported profiles appears
 * in both players' archives; `games.profile_username` keeps the first importer (the owner) and
 * this table links the game to every profile so each one's game list and counts include it.
 */
export const gameProfiles = sqliteTable(
  'game_profiles',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    profileUsername: text('profile_username')
      .notNull()
      .references(() => profiles.username),
    importedAt: text('imported_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.profileUsername] }), index('game_profiles_profile_idx').on(t.profileUsername)],
);

export const positionAnalyses = sqliteTable(
  'position_analyses',
  {
    fen: text('fen').notNull(),
    /** REQUESTED depth (what the settings asked for), not the depth the engine reached. */
    depth: integer('depth').notNull(),
    multipv: integer('multipv').notNull(),
    engine: text('engine').notNull(),
    /** Requested movetime in ms; 0 for a depth-limited search. */
    movetimeMs: integer('movetime_ms').notNull().default(0),
    linesJson: text('lines_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.fen, t.depth, t.multipv, t.engine, t.movetimeMs] })],
);

export const gameAnalyses = sqliteTable(
  'game_analyses',
  {
    gameId: text('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    settingsKey: text('settings_key').notNull(),
    analysisJson: text('analysis_json').notNull(),
    analyzedAt: text('analyzed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.settingsKey] })],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
});

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    /** 'import' | 'analysis' */
    kind: text('kind').notNull(),
    payloadJson: text('payload_json').notNull(),
    /** JobStatus */
    status: text('status').notNull(),
    /** 0..1 */
    progress: real('progress').notNull().default(0),
    error: text('error'),
    createdAt: text('created_at').notNull(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [index('jobs_status_created_idx').on(t.status, t.createdAt)],
);

export const schema = { profiles, games, gameProfiles, positionAnalyses, gameAnalyses, settings, jobs };

export type ProfileRow = typeof profiles.$inferSelect;
export type GameRow = typeof games.$inferSelect;
export type GameProfileRow = typeof gameProfiles.$inferSelect;
export type NewGameRow = typeof games.$inferInsert;
export type PositionAnalysisRow = typeof positionAnalyses.$inferSelect;
export type GameAnalysisRow = typeof gameAnalyses.$inferSelect;
export type SettingRow = typeof settings.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;
