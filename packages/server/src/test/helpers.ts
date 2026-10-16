/**
 * Test doubles: fake engine, fake opening book, fake analyzeGame, mocked chess.com fetch.
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  AnalysisSettings,
  AnalyzeGameOptions,
  GameAnalysis,
  OpeningBook,
  OpeningLine,
  PositionAnalysis,
  SearchSettings,
  UciEngine,
  UciEngineOptions,
} from '@chess-analyzer/core';
import { buildApp, type App, type AppDeps, type BuildAppOptions } from '../app.js';
import { REPO_ROOT } from '../config.js';
import type { Db } from '../db/index.js';
import { games, profiles, type NewGameRow } from '../db/schema.js';
import type { ChesscomArchiveGame } from '../import/chesscom.js';

export const FIXTURE_ARCHIVE_PATH = path.join(REPO_ROOT, 'data', 'fixtures', 'chesscom-archive-sample.json');

export function loadFixtureArchive(): ChesscomArchiveGame[] {
  const raw = JSON.parse(fs.readFileSync(FIXTURE_ARCHIVE_PATH, 'utf8')) as { games: ChesscomArchiveGame[] };
  return raw.games;
}

/** Same rule as the core helper: last path segment, '-' -> ' ', drop the "...moves" suffix. */
export function fakeOpeningNameFromEcoUrl(url: string): string {
  const segment = url.split('/').filter(Boolean).pop() ?? '';
  const withoutMoves = segment.split('...')[0] ?? segment;
  return withoutMoves.replace(/-/g, ' ').trim();
}

export function fakeSettingsKey(settings: AnalysisSettings, engineName: string): string {
  return [engineName, `d${settings.depth}`, `pv${settings.multiPv}`, settings.movetimeMs ? `mt${settings.movetimeMs}` : 'mt0'].join('|');
}

export class FakeEngine implements Pick<UciEngine, 'start' | 'analyse' | 'stop' | 'setOptions' | 'quit' | 'name'> {
  static created: FakeEngineInstance[] = [];
  readonly instance: FakeEngineInstance;

  constructor(opts: UciEngineOptions, engineName = 'FakeFish 1') {
    this.instance = { opts, engineName, started: false, quit: false, stops: 0 };
    FakeEngine.created.push(this.instance);
  }
  async start(): Promise<string> {
    this.instance.started = true;
    return this.instance.engineName;
  }
  async analyse(fen: string, settings: SearchSettings): Promise<PositionAnalysis> {
    return {
      fen,
      depth: settings.depth,
      multipv: settings.multiPv,
      engine: this.instance.engineName,
      lines: [{ multipv: 1, depth: settings.depth, score: { type: 'cp', value: 20 }, pv: ['e2e4'] }],
    };
  }
  stop(): void {
    this.instance.stops++;
  }
  async setOptions(): Promise<void> {}
  async quit(): Promise<void> {
    this.instance.quit = true;
  }
  get name(): string {
    return this.instance.engineName;
  }
}

export interface FakeEngineInstance {
  opts: UciEngineOptions;
  engineName: string;
  started: boolean;
  quit: boolean;
  stops: number;
}

export const FAKE_OPENINGS: OpeningLine[] = [
  { eco: 'B02', name: "Alekhine's Defense", moves: ['e4', 'Nf6'], pgn: '1. e4 Nf6' },
  { eco: 'B02', name: "Alekhine's Defense: Maroczy Variation", moves: ['e4', 'Nf6', 'd3'], pgn: '1. e4 Nf6 2. d3' },
  { eco: 'C20', name: "King's Pawn Game", moves: ['e4', 'e5'], pgn: '1. e4 e5' },
  { eco: 'A40', name: 'Modern Defense', moves: ['d4', 'g6'], pgn: '1. d4 g6' },
];

export function fakeBook(lines: OpeningLine[] = FAKE_OPENINGS): OpeningBook {
  const book = {
    lookupByMoves: (moves: string[]) => lines.find((l) => l.moves.join(' ') === moves.join(' ')),
    isBookMove: (soFar: string[], san: string) => {
      const prefix = [...soFar, san].join(' ');
      return lines.some((l) => l.moves.join(' ').startsWith(prefix));
    },
    longestMatch: () => undefined,
    search: (q: string, limit = 200) =>
      lines.filter((l) => `${l.eco} ${l.name}`.toLowerCase().includes(q.toLowerCase())).slice(0, limit),
    byEco: (eco: string) => lines.filter((l) => l.eco === eco),
    list: () => lines,
    size: lines.length,
  };
  return book as unknown as OpeningBook;
}

export function fakeGameAnalysis(opts: AnalyzeGameOptions, engineName = 'FakeFish 1'): GameAnalysis {
  const counts = {
    brilliant: 0, great: 0, best: 1, excellent: 0, good: 0, book: 1, inaccuracy: 0, mistake: 0, miss: 0, blunder: 0,
  };
  return {
    gameId: opts.gameId,
    settings: opts.settings,
    settingsKey: fakeSettingsKey(opts.settings, engineName),
    moves: [],
    white: { username: opts.whiteUsername, accuracy: 90, estimatedRating: 1500, averageCpLoss: 20, counts },
    black: { username: opts.blackUsername, accuracy: 85, estimatedRating: 1400, averageCpLoss: 30, counts },
    opening: { eco: 'B02', name: "Alekhine's Defense", lastBookPly: 2 },
    keyMoments: [],
    analyzedAt: new Date().toISOString(),
  };
}

/** analyzeGame double: emits a few progress ticks and honours the abort signal. */
export function fakeAnalyzeGame(options: { stepMs?: number; steps?: number } = {}) {
  const steps = options.steps ?? 4;
  const stepMs = options.stepMs ?? 5;
  return async (opts: AnalyzeGameOptions): Promise<GameAnalysis> => {
    for (let i = 1; i <= steps; i++) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, stepMs);
        opts.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(opts.signal?.reason instanceof Error ? opts.signal.reason : new Error('aborted'));
          },
          { once: true },
        );
      });
      opts.onProgress?.(i / steps);
    }
    const first = opts.engine ? await opts.engine.analyse('startpos', opts.settings) : undefined;
    await opts.cache?.set(first ?? { fen: 'startpos', depth: 1, multipv: 1, engine: 'x', lines: [] });
    return fakeGameAnalysis(opts, opts.engine.name);
  };
}

export interface FakeChesscomServer {
  /** username (lowercase) -> archive URL -> games */
  users: Record<string, Record<string, ChesscomArchiveGame[]>>;
  calls: { url: string; headers: Record<string, string> }[];
  fetch: typeof fetch;
}

export function makeFakeChesscom(users: FakeChesscomServer['users']): FakeChesscomServer {
  const calls: FakeChesscomServer['calls'] = [];
  const json = (status: number, body: unknown, url: string) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-url': url } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const h = init?.headers;
    if (h instanceof Headers) h.forEach((v, k) => (headers[k.toLowerCase()] = v));
    else if (Array.isArray(h)) for (const [k, v] of h) headers[k.toLowerCase()] = v;
    else if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    calls.push({ url, headers });

    const player = /\/pub\/player\/([^/]+)(\/games\/archives)?$/.exec(url);
    if (player) {
      const name = decodeURIComponent(player[1] as string);
      const archives = users[name];
      if (!archives) return json(404, { code: 0, message: 'User not found' }, url);
      if (player[2]) return json(200, { archives: Object.keys(archives) }, url);
      return json(200, { username: name, player_id: 1 }, url);
    }
    for (const archives of Object.values(users)) {
      if (archives[url]) return json(200, { games: archives[url] }, url);
    }
    return json(404, { message: 'not found' }, url);
  };
  return { users, calls, fetch: fetchImpl };
}

export function cloneGame(game: ChesscomArchiveGame, patch: Partial<ChesscomArchiveGame>): ChesscomArchiveGame {
  return { ...structuredClone(game), ...patch };
}

export interface TestAppOptions {
  deps?: AppDeps;
  startQueue?: boolean;
  config?: BuildAppOptions['config'];
}

export async function createTestApp(opts: TestAppOptions = {}): Promise<App> {
  FakeEngine.created = [];
  const deps: AppDeps = {
    createEngine: (o) => new FakeEngine(o) as unknown as UciEngine,
    loadBook: async () => fakeBook(),
    analyzeGame: fakeAnalyzeGame(),
    settingsKey: fakeSettingsKey,
    openingNameFromEcoUrl: fakeOpeningNameFromEcoUrl,
    heartbeatMs: 50,
    ...opts.deps,
  };
  const app = await buildApp({
    config: { dbPath: ':memory:', webDist: path.join(REPO_ROOT, 'packages', 'web', 'does-not-exist'), ...opts.config },
    env: {},
    logger: false,
    deps,
    startQueue: opts.startQueue ?? true,
  });
  await app.ready();
  return app;
}

export function insertProfile(db: Db, username: string, lastSync: number | null = null): void {
  db.insert(profiles).values({ username, lastSync, createdAt: new Date().toISOString() }).onConflictDoNothing().run();
}

let gameSeq = 0;

export function insertGame(db: Db, patch: Partial<NewGameRow> & { profileUsername: string }): NewGameRow {
  gameSeq++;
  const row: NewGameRow = {
    id: patch.id ?? `game-${gameSeq}`,
    url: `https://www.chess.com/game/live/${gameSeq}`,
    timeClass: 'blitz',
    timeControl: '300',
    rated: true,
    endTime: 1_700_000_000 + gameSeq * 60,
    whiteUsername: 'alice',
    whiteRating: 1500,
    whiteResult: 'win',
    blackUsername: 'bob',
    blackRating: 1480,
    blackResult: 'resigned',
    result: '1-0',
    pgn: '[Event "Live Chess"]\n[Result "1-0"]\n\n1. e4 e5 1-0',
    eco: 'C20',
    openingName: "King's Pawn Game",
    importedAt: new Date().toISOString(),
    ...patch,
  };
  insertProfile(db, row.profileUsername);
  db.insert(games).values(row).run();
  return row;
}

export async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 5000, intervalMs = 10): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
