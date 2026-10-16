/**
 * chess.com public-API importer. See docs/ARCHITECTURE.md ("chess.com importer").
 */
import { openingNameFromEcoUrl as coreOpeningNameFromEcoUrl, type GameResult, type TimeClass } from '@chess-analyzer/core';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { gameProfiles, games, profiles, type NewGameRow } from '../db/schema.js';

export const CHESSCOM_API_BASE = 'https://api.chess.com/pub';
export const USER_AGENT = 'chess-analyzer/0.1 (local)';
export const KEPT_TIME_CLASSES: readonly TimeClass[] = ['bullet', 'blitz', 'rapid'];
export const DEFAULT_LATEST_COUNT = 20;

export type ChesscomErrorCode = 'USER_NOT_FOUND' | 'HTTP' | 'NETWORK' | 'BAD_RESPONSE';

export class ChesscomError extends Error {
  constructor(
    message: string,
    readonly code: ChesscomErrorCode,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ChesscomError';
  }
}

export interface ChesscomPlayerSide {
  username: string;
  rating: number;
  result: string;
  '@id'?: string;
  uuid?: string;
}

export interface ChesscomArchiveGame {
  uuid: string;
  url: string;
  pgn?: string;
  time_class: string;
  time_control: string;
  rated: boolean;
  end_time: number;
  rules: string;
  white: ChesscomPlayerSide;
  black: ChesscomPlayerSide;
  eco?: string;
  tcn?: string;
  initial_setup?: string;
  fen?: string;
}

export interface ChesscomClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  userAgent?: string;
  /** Attempts for 429 / 5xx responses (default 3). */
  retries?: number;
  /** Base delay between retries, in ms (default 1000). */
  retryDelayMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class ChesscomClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(opts: ChesscomClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.baseUrl = (opts.baseUrl ?? CHESSCOM_API_BASE).replace(/\/+$/, '');
    this.userAgent = opts.userAgent ?? USER_AGENT;
    this.retries = Math.max(1, opts.retries ?? 3);
    this.retryDelayMs = opts.retryDelayMs ?? 1000;
  }

  playerUrl(username: string): string {
    return `${this.baseUrl}/player/${encodeURIComponent(username.toLowerCase())}`;
  }

  /** Throws ChesscomError('USER_NOT_FOUND') for unknown users. */
  async getPlayer(username: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const res = await this.request(this.playerUrl(username), signal);
    if (res.status === 404) {
      throw new ChesscomError(`chess.com user "${username}" was not found`, 'USER_NOT_FOUND', 404);
    }
    await this.assertOk(res);
    return (await res.json()) as Record<string, unknown>;
  }

  /** Monthly archive URLs, oldest first (as chess.com returns them). */
  async getArchives(username: string, signal?: AbortSignal): Promise<string[]> {
    const res = await this.request(`${this.playerUrl(username)}/games/archives`, signal);
    if (res.status === 404) {
      throw new ChesscomError(`chess.com user "${username}" was not found`, 'USER_NOT_FOUND', 404);
    }
    await this.assertOk(res);
    const body = (await res.json()) as { archives?: unknown };
    if (!Array.isArray(body.archives) || !body.archives.every((a) => typeof a === 'string')) {
      throw new ChesscomError('Unexpected archives response from chess.com', 'BAD_RESPONSE', res.status);
    }
    return body.archives as string[];
  }

  async getArchive(url: string, signal?: AbortSignal): Promise<ChesscomArchiveGame[]> {
    const res = await this.request(url, signal);
    await this.assertOk(res);
    const body = (await res.json()) as { games?: unknown };
    if (!Array.isArray(body.games)) {
      throw new ChesscomError(`Unexpected archive response for ${url}`, 'BAD_RESPONSE', res.status);
    }
    return body.games as ChesscomArchiveGame[];
  }

  private async assertOk(res: Response): Promise<void> {
    if (res.ok) return;
    throw new ChesscomError(`chess.com responded ${res.status} ${res.statusText} for ${res.url}`, 'HTTP', res.status);
  }

  private async request(url: string, signal?: AbortSignal): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
          signal,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = err;
        if (attempt < this.retries) {
          await sleep(this.retryDelayMs * attempt, signal);
          continue;
        }
        throw new ChesscomError(`Network error fetching ${url}: ${errorMessage(err)}`, 'NETWORK');
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : this.retryDelayMs * attempt;
        await sleep(delay, signal);
        continue;
      }
      return res;
    }
    throw new ChesscomError(`Failed to fetch ${url}: ${errorMessage(lastError)}`, 'NETWORK');
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Month index (year * 12 + month - 1) of an archive URL ending in /YYYY/MM. */
export function archiveMonthIndex(url: string): number | undefined {
  const m = /\/(\d{4})\/(\d{2})\/?$/.exec(url);
  if (!m) return undefined;
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

/** Month index (UTC) of a unix-seconds timestamp. */
export function monthIndexOfUnix(unixSeconds: number): number {
  const d = new Date(unixSeconds * 1000);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/** Parse `[Key "Value"]` PGN tag pairs. */
export function parsePgnHeaders(pgn: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const re = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pgn)) !== null) {
    headers[m[1] as string] = (m[2] as string).replace(/\\(["\\])/g, '$1');
  }
  return headers;
}

const GAME_RESULTS: readonly GameResult[] = ['1-0', '0-1', '1/2-1/2', '*'];

export function resultFromHeader(value: string | undefined): GameResult {
  return (GAME_RESULTS as readonly string[]).includes(value ?? '') ? (value as GameResult) : '*';
}

export function isKeptGame(game: ChesscomArchiveGame): game is ChesscomArchiveGame & { time_class: TimeClass } {
  return game.rules === 'chess' && (KEPT_TIME_CLASSES as readonly string[]).includes(game.time_class);
}

export function mapArchiveGame(
  game: ChesscomArchiveGame,
  profileUsername: string,
  importedAt: string,
  openingNameFromEcoUrl: (url: string) => string = coreOpeningNameFromEcoUrl,
): NewGameRow {
  const pgn = game.pgn ?? '';
  const headers = parsePgnHeaders(pgn);
  const eco = headers.ECO?.trim() || undefined;
  const ecoUrl = headers.ECOUrl?.trim();
  const openingName = ecoUrl ? openingNameFromEcoUrl(ecoUrl) || undefined : undefined;
  return {
    id: game.uuid,
    url: game.url,
    profileUsername,
    timeClass: game.time_class,
    timeControl: game.time_control,
    rated: Boolean(game.rated),
    endTime: game.end_time,
    whiteUsername: game.white.username,
    whiteRating: game.white.rating,
    whiteResult: game.white.result,
    blackUsername: game.black.username,
    blackRating: game.black.rating,
    blackResult: game.black.result,
    result: resultFromHeader(headers.Result),
    pgn,
    eco: eco ?? null,
    openingName: openingName ?? null,
    importedAt,
  };
}

export interface ImportProgress {
  /** 0..1 */
  progress: number;
  imported: number;
  skipped: number;
  archivesFetched: number;
  archivesTotal: number;
}

export interface ImportOptions {
  db: Db;
  username: string;
  mode: 'all' | 'latest';
  /** Number of games to keep in 'latest' mode (default DEFAULT_LATEST_COUNT). */
  count?: number;
  client?: ChesscomClient;
  openingNameFromEcoUrl?: (url: string) => string;
  now?: () => Date;
  signal?: AbortSignal;
  onProgress?: (progress: ImportProgress) => void;
}

export interface ImportResult {
  username: string;
  imported: number;
  skipped: number;
  archivesFetched: number;
  /** Ids of the games written, newest first. */
  gameIds: string[];
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Import cancelled');
}

/**
 * Import games for a chess.com user into the database.
 * - 'latest': walk archives from newest, stop once `count` games are kept.
 * - 'all': every archive; on resync only months >= the profile's last_sync month.
 *
 * `profiles.last_sync` is written only when an 'all' import completes: it marks the point up to
 * which the profile's history is known to be complete. A 'latest N' import leaves it untouched,
 * so a later 'all' import still fetches every month.
 *
 * A game that was already imported for another profile (both players are imported profiles) is
 * updated in place, keeps its original owner (`games.profile_username`) and is linked to this
 * profile through `game_profiles`.
 */
export async function importChesscomGames(opts: ImportOptions): Promise<ImportResult> {
  const username = opts.username.trim().toLowerCase();
  if (!username) throw new ChesscomError('Username is required', 'BAD_RESPONSE');
  const client = opts.client ?? new ChesscomClient();
  const now = opts.now ?? (() => new Date());
  const openingName = opts.openingNameFromEcoUrl ?? coreOpeningNameFromEcoUrl;
  const { db, signal } = opts;
  const count = opts.mode === 'latest' ? Math.max(1, opts.count ?? DEFAULT_LATEST_COUNT) : undefined;

  await client.getPlayer(username, signal);
  throwIfAborted(signal);

  const existing = db.select().from(profiles).where(eq(profiles.username, username)).get();
  if (!existing) {
    db.insert(profiles).values({ username, lastSync: null, createdAt: now().toISOString() }).run();
  }

  let archives = await client.getArchives(username, signal);
  throwIfAborted(signal);

  if (opts.mode === 'all' && existing?.lastSync) {
    const fromMonth = monthIndexOfUnix(existing.lastSync);
    archives = archives.filter((url) => {
      const month = archiveMonthIndex(url);
      return month === undefined || month >= fromMonth;
    });
  } else if (opts.mode === 'latest') {
    archives = [...archives].reverse();
  }

  let imported = 0;
  let skipped = 0;
  let archivesFetched = 0;
  const gameIds: string[] = [];
  const endTimes = new Map<string, number>();
  const total = archives.length;

  const report = () => {
    const progress =
      count !== undefined
        ? Math.min(1, total === 0 ? 1 : Math.max(imported / count, archivesFetched / total))
        : total === 0
          ? 1
          : archivesFetched / total;
    opts.onProgress?.({ progress, imported, skipped, archivesFetched, archivesTotal: total });
  };

  const upsertMany = (rows: NewGameRow[]): void => {
    if (rows.length === 0) return;
    db.transaction((tx) => {
      for (const row of rows) {
        // The first importer stays the owner; everything chess.com may have changed is refreshed.
        const { id: _id, importedAt: _importedAt, profileUsername: _owner, ...update } = row;
        tx.insert(games).values(row).onConflictDoUpdate({ target: games.id, set: update }).run();
        tx.insert(gameProfiles)
          .values({ gameId: row.id, profileUsername: username, importedAt: row.importedAt })
          .onConflictDoNothing()
          .run();
      }
    });
  };

  for (const archiveUrl of archives) {
    throwIfAborted(signal);
    const archiveGames = await client.getArchive(archiveUrl, signal);
    throwIfAborted(signal);
    archivesFetched++;

    let kept = archiveGames.filter((g) => {
      if (isKeptGame(g) && typeof g.uuid === 'string' && g.uuid.length > 0) return true;
      skipped++;
      return false;
    });

    if (count !== undefined) {
      kept.sort((a, b) => b.end_time - a.end_time);
      const remaining = count - imported;
      if (kept.length > remaining) kept = kept.slice(0, remaining);
    }

    const importedAt = now().toISOString();
    const rows = kept.map((g) => mapArchiveGame(g, username, importedAt, openingName));
    upsertMany(rows);
    imported += rows.length;
    for (const row of rows) {
      gameIds.push(row.id);
      endTimes.set(row.id, row.endTime);
    }
    report();

    if (count !== undefined && imported >= count) break;
  }

  if (opts.mode === 'all') {
    db.update(profiles)
      .set({ lastSync: Math.floor(now().getTime() / 1000) })
      .where(eq(profiles.username, username))
      .run();
  }

  gameIds.sort((a, b) => (endTimes.get(b) ?? 0) - (endTimes.get(a) ?? 0));

  return { username, imported, skipped, archivesFetched, gameIds };
}
