/**
 * Game repository: list / get games as `GameRecord`s and store analyses.
 */
import type { GameAnalysis, GameRecord, GameResult, Profile, TimeClass } from '@chess-analyzer/core';
import { and, count, desc, eq, exists, notExists, sql } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { gameAnalyses, gameProfiles, games, profiles, type GameRow } from './db/schema.js';

export interface GameListFilter {
  profile?: string;
  timeClass?: TimeClass;
  analyzed?: boolean;
  /** 1-based. */
  page?: number;
  pageSize?: number;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export type GameAccuracy = NonNullable<GameRecord['accuracy']>;

/**
 * `profile` is the profile the record is being viewed for (the `?profile=` filter); it replaces
 * the owner in `profileUsername` so the UI orients the board from that player's side.
 */
export function toGameRecord(row: GameRow, analyzed: boolean, accuracy?: GameAccuracy, profile?: string): GameRecord {
  const record: GameRecord = {
    id: row.id,
    url: row.url,
    profileUsername: profile ?? row.profileUsername,
    timeClass: row.timeClass as TimeClass,
    timeControl: row.timeControl,
    rated: row.rated,
    endTime: row.endTime,
    white: { username: row.whiteUsername, rating: row.whiteRating, result: row.whiteResult },
    black: { username: row.blackUsername, rating: row.blackRating, result: row.blackResult },
    result: row.result as GameResult,
    pgn: row.pgn,
    analyzed,
  };
  if (row.eco) record.eco = row.eco;
  if (row.openingName) record.openingName = row.openingName;
  if (accuracy) record.accuracy = accuracy;
  return record;
}

function toAccuracy(white: unknown, black: unknown): GameAccuracy | undefined {
  const w = typeof white === 'number' ? white : Number(white);
  const b = typeof black === 'number' ? black : Number(black);
  if (white === null || black === null || !Number.isFinite(w) || !Number.isFinite(b)) return undefined;
  return { white: w, black: b };
}

export class GameRepository {
  constructor(private readonly db: Db) {}

  /**
   * Subquery: an analysis exists for the outer game row. When `settingsKey` is undefined
   * (engine never started, so the key is unknown) any analysis counts.
   */
  private analysisExists(settingsKey: string | undefined) {
    return this.db
      .select({ one: sql`1` })
      .from(gameAnalyses)
      .where(
        and(eq(gameAnalyses.gameId, games.id), settingsKey === undefined ? undefined : eq(gameAnalyses.settingsKey, settingsKey)),
      );
  }

  /**
   * Scalar subquery: a player's accuracy from the analysis matching `settingsKey` (the most
   * recent analysis when the key is unknown), or NULL when the game is not analysed.
   */
  private accuracyOf(color: 'white' | 'black', settingsKey: string | undefined) {
    const keyCond = settingsKey === undefined ? sql`` : sql` and ${gameAnalyses.settingsKey} = ${settingsKey}`;
    return sql<number | null>`(select json_extract(${gameAnalyses.analysisJson}, ${`$.${color}.accuracy`}) from ${gameAnalyses} where ${gameAnalyses.gameId} = ${games.id}${keyCond} order by ${gameAnalyses.analyzedAt} desc limit 1)`;
  }

  /** Subquery: the outer game row is linked to `profile` (owner or later importer). */
  private linkedToProfile(profile: string) {
    return exists(
      this.db
        .select({ one: sql`1` })
        .from(gameProfiles)
        .where(and(eq(gameProfiles.gameId, games.id), eq(gameProfiles.profileUsername, profile))),
    );
  }

  list(filter: GameListFilter, settingsKey: string | undefined): { items: GameRecord[]; total: number } {
    const page = Math.max(1, Math.floor(filter.page ?? 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(filter.pageSize ?? DEFAULT_PAGE_SIZE)));
    const profile = filter.profile?.trim().toLowerCase() || undefined;
    const conds = [];
    if (profile) conds.push(this.linkedToProfile(profile));
    if (filter.timeClass) conds.push(eq(games.timeClass, filter.timeClass));
    if (filter.analyzed !== undefined) {
      const sub = this.analysisExists(settingsKey);
      conds.push(filter.analyzed ? exists(sub) : notExists(sub));
    }
    const where = conds.length ? and(...conds) : undefined;

    const total = this.db.select({ value: count() }).from(games).where(where).get()?.value ?? 0;
    const rows = this.db
      .select({
        game: games,
        analyzed: exists(this.analysisExists(settingsKey)).mapWith(Boolean),
        accuracyWhite: this.accuracyOf('white', settingsKey),
        accuracyBlack: this.accuracyOf('black', settingsKey),
      })
      .from(games)
      .where(where)
      .orderBy(desc(games.endTime), desc(games.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();

    return {
      items: rows.map((r) => {
        const analyzed = Boolean(r.analyzed);
        return toGameRecord(r.game, analyzed, analyzed ? toAccuracy(r.accuracyWhite, r.accuracyBlack) : undefined, profile);
      }),
      total,
    };
  }

  getRow(id: string): GameRow | undefined {
    return this.db.select().from(games).where(eq(games.id, id)).get();
  }

  /**
   * One game with its analysis. `profile`, when given and linked to the game, becomes the
   * record's `profileUsername` (the side the viewer plays); otherwise the owner is reported.
   */
  get(id: string, settingsKey: string | undefined, profile?: string): { game: GameRecord; analysis?: GameAnalysis } | undefined {
    const row = this.getRow(id);
    if (!row) return undefined;
    const analysisRow = this.getAnalysisRow(id, settingsKey);
    const analysis = analysisRow ? (JSON.parse(analysisRow.analysisJson) as GameAnalysis) : undefined;
    const analyzed = settingsKey === undefined ? analysisRow !== undefined : analysisRow?.settingsKey === settingsKey;
    const accuracy = analyzed && analysis ? toAccuracy(analysis.white.accuracy, analysis.black.accuracy) : undefined;
    const viewer = profile?.trim().toLowerCase() || undefined;
    const viewAs = viewer && this.isLinked(id, viewer) ? viewer : undefined;
    const result: { game: GameRecord; analysis?: GameAnalysis } = { game: toGameRecord(row, analyzed, accuracy, viewAs) };
    if (analysis) result.analysis = analysis;
    return result;
  }

  /** Profiles (lowercase) the game is linked to, owner first. */
  profilesOf(gameId: string): string[] {
    const owner = this.getRow(gameId)?.profileUsername;
    const linked = this.db
      .select({ profile: gameProfiles.profileUsername })
      .from(gameProfiles)
      .where(eq(gameProfiles.gameId, gameId))
      .orderBy(gameProfiles.importedAt)
      .all()
      .map((r) => r.profile);
    return [...new Set([...(owner ? [owner] : []), ...linked])];
  }

  private isLinked(gameId: string, profile: string): boolean {
    return (
      this.db
        .select({ one: sql`1` })
        .from(gameProfiles)
        .where(and(eq(gameProfiles.gameId, gameId), eq(gameProfiles.profileUsername, profile)))
        .get() !== undefined
    );
  }

  /** The analysis for `settingsKey`, falling back to the most recent analysis of the game. */
  private getAnalysisRow(gameId: string, settingsKey: string | undefined) {
    if (settingsKey !== undefined) {
      const exact = this.db
        .select()
        .from(gameAnalyses)
        .where(and(eq(gameAnalyses.gameId, gameId), eq(gameAnalyses.settingsKey, settingsKey)))
        .get();
      if (exact) return exact;
    }
    return this.db
      .select()
      .from(gameAnalyses)
      .where(eq(gameAnalyses.gameId, gameId))
      .orderBy(desc(gameAnalyses.analyzedAt))
      .limit(1)
      .get();
  }

  /** True when an analysis exists for `settingsKey` (any analysis when the key is unknown). */
  hasAnalysis(gameId: string, settingsKey: string | undefined): boolean {
    const row = this.db
      .select({ value: count() })
      .from(gameAnalyses)
      .where(and(eq(gameAnalyses.gameId, gameId), settingsKey === undefined ? undefined : eq(gameAnalyses.settingsKey, settingsKey)))
      .get();
    return (row?.value ?? 0) > 0;
  }

  saveAnalysis(analysis: GameAnalysis): void {
    const analysisJson = JSON.stringify(analysis);
    this.db
      .insert(gameAnalyses)
      .values({ gameId: analysis.gameId, settingsKey: analysis.settingsKey, analysisJson, analyzedAt: analysis.analyzedAt })
      .onConflictDoUpdate({
        target: [gameAnalyses.gameId, gameAnalyses.settingsKey],
        set: { analysisJson, analyzedAt: analysis.analyzedAt },
      })
      .run();
  }

  /** Newest game ids of a profile, optionally only those without an analysis for `settingsKey`. */
  latestGameIds(profileUsername: string, limit: number, opts: { unanalyzedFor?: string | undefined; onlyUnanalyzed?: boolean } = {}): string[] {
    const conds = [this.linkedToProfile(profileUsername.toLowerCase())];
    if (opts.onlyUnanalyzed) conds.push(notExists(this.analysisExists(opts.unanalyzedFor)));
    return this.db
      .select({ id: games.id })
      .from(games)
      .where(and(...conds))
      .orderBy(desc(games.endTime), desc(games.id))
      .limit(Math.max(0, limit))
      .all()
      .map((r) => r.id);
  }

  listProfiles(): Profile[] {
    const rows = this.db
      .select({ username: profiles.username, lastSync: profiles.lastSync, gameCount: count(gameProfiles.gameId) })
      .from(profiles)
      .leftJoin(gameProfiles, eq(gameProfiles.profileUsername, profiles.username))
      .groupBy(profiles.username)
      .orderBy(profiles.username)
      .all();
    return rows.map((r) => {
      const profile: Profile = { username: r.username, gameCount: Number(r.gameCount) };
      if (r.lastSync !== null && r.lastSync !== undefined) profile.lastSync = r.lastSync;
      return profile;
    });
  }
}
