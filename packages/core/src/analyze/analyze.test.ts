import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';

import type { AnalysisSettings, EngineLine, EngineScore, PositionAnalysis } from '../types.js';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../config/thresholds.js';
import type { UciEngine } from '../engine/index.js';
import type { OpeningBook } from '../openings/index.js';
import type { ParsedGame, ParsedMove } from '../pgn/index.js';
import type { ClassificationDetail, MoveContext } from '../classify/index.js';

vi.mock('../pgn/index.js', () => ({
  parsePgn: vi.fn(),
}));

vi.mock('../classify/index.js', () => ({
  classifyMove: vi.fn(),
  gameAccuracy: vi.fn(),
  estimateRating: vi.fn(),
}));

import { parsePgn } from '../pgn/index.js';
import { classifyMove, estimateRating, gameAccuracy } from '../classify/index.js';
import {
  analyzeGame,
  deriveForcedMoveAnalysis,
  forcedMove,
  isAnalysisAbortError,
  selectKeyMoments,
  settingsKey,
  terminalScore,
  type AnalyzeGameOptions,
  type PositionCache,
} from './index.js';

const parsePgnMock = vi.mocked(parsePgn);
const classifyMock = vi.mocked(classifyMove);
const gameAccuracyMock = vi.mocked(gameAccuracy);
const estimateRatingMock = vi.mocked(estimateRating);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENGINE_NAME = 'FakeFish 1';

const SETTINGS: AnalysisSettings = {
  depth: 12,
  multiPv: 2,
  threads: 1,
  hashMb: 16,
  enginePath: 'engines/stockfish',
};

/** Build a ParsedGame from SAN moves with real chess.js FENs (the pgn module itself is mocked). */
function makeGame(sans: string[]): ParsedGame {
  const chess = new Chess();
  const initialFen = chess.fen();
  const moves: ParsedMove[] = sans.map((san, i) => {
    const fenBefore = chess.fen();
    const m = chess.move(san);
    return {
      ply: i + 1,
      color: m.color,
      san: m.san,
      uci: `${m.from}${m.to}${m.promotion ?? ''}`,
      fenBefore,
      fenAfter: chess.fen(),
      clockSeconds: 600 - i,
    };
  });
  return { headers: { White: 'alice', Black: 'bob' }, moves, initialFen };
}

/** Engine lines for `fen`: the first two legal moves in chess.js order, 3-move PVs. */
function defaultAnalysis(fen: string, score: EngineScore = { type: 'cp', value: 20 }): PositionAnalysis {
  const chess = new Chess(fen);
  const legal = chess.moves({ verbose: true });
  const lines: EngineLine[] = legal.slice(0, 2).map((m, idx) => {
    const walker = new Chess(fen);
    const pv: string[] = [];
    let next: { from: string; to: string; promotion?: string } | undefined = m;
    for (let i = 0; i < 3 && next; i++) {
      const played = walker.move(next);
      pv.push(`${played.from}${played.to}${played.promotion ?? ''}`);
      next = walker.moves({ verbose: true })[0];
    }
    return {
      multipv: idx + 1,
      score: idx === 0 ? score : { type: 'cp', value: score.type === 'cp' ? score.value - 30 : 0 },
      depth: SETTINGS.depth,
      pv,
    };
  });
  return { fen, depth: SETTINGS.depth, multipv: SETTINGS.multiPv, lines, engine: ENGINE_NAME };
}

interface FakeEngine {
  name: string;
  analyse: ReturnType<typeof vi.fn<(fen: string, settings: unknown) => Promise<PositionAnalysis>>>;
  stop: ReturnType<typeof vi.fn<() => void>>;
}

function makeEngine(script: Record<string, PositionAnalysis> = {}): FakeEngine {
  return {
    name: ENGINE_NAME,
    analyse: vi.fn(async (fen: string) => script[fen] ?? defaultAnalysis(fen)),
    stop: vi.fn(),
  };
}

interface FakeBook {
  isBookMove: ReturnType<typeof vi.fn<(soFar: string[], san: string) => boolean>>;
  longestMatch: ReturnType<typeof vi.fn<(sans: string[]) => { opening: { eco: string; name: string }; plies: number } | undefined>>;
}

/** A book that knows the first `bookPlies` moves of the scripted game. */
function makeBook(bookPlies: number): FakeBook {
  return {
    isBookMove: vi.fn((soFar: string[]) => soFar.length < bookPlies),
    longestMatch: vi.fn((sans: string[]) =>
      sans.length === 0
        ? undefined
        : { opening: { eco: 'A04', name: 'Zukertort Opening' }, plies: Math.min(sans.length, bookPlies) },
    ),
  };
}

function makeCache(seed: PositionAnalysis[] = []) {
  const store = new Map<string, PositionAnalysis>();
  for (const a of seed) store.set(a.fen, a);
  return {
    store,
    get: vi.fn(async (fen: string) => store.get(fen)),
    set: vi.fn(async (a: PositionAnalysis) => {
      store.set(a.fen, a);
    }),
  } satisfies PositionCache & { store: Map<string, PositionAnalysis> };
}

function detail(partial: Partial<ClassificationDetail> & { classification: ClassificationDetail['classification'] }): ClassificationDetail {
  return {
    winProbBefore: 0.5,
    winProbAfter: 0.5,
    winProbLoss: 0,
    cpLoss: 0,
    isBest: true,
    isSacrifice: false,
    ...partial,
  };
}

function baseOptions(overrides: Partial<AnalyzeGameOptions> = {}): AnalyzeGameOptions {
  return {
    gameId: 'game-1',
    pgn: '1. Nf3 Nc6 2. Ng1 Nb8',
    timeClass: 'blitz',
    whiteUsername: 'alice',
    blackUsername: 'bob',
    whiteRating: 1500,
    blackRating: 1450,
    engine: makeEngine() as unknown as UciEngine,
    book: makeBook(2) as unknown as OpeningBook,
    settings: SETTINGS,
    thresholds: DEFAULT_THRESHOLDS,
    ...overrides,
  };
}

const GAME = makeGame(['Nf3', 'Nc6', 'Ng1', 'Nb8']);

beforeEach(() => {
  vi.clearAllMocks();
  parsePgnMock.mockReturnValue(GAME);
  classifyMock.mockImplementation((ctx: MoveContext) =>
    detail({ classification: ctx.isBook ? 'book' : 'best' }),
  );
  gameAccuracyMock.mockImplementation((_moves, color) => (color === 'w' ? 91.5 : 77.25));
  estimateRatingMock.mockImplementation((avgCpLoss) => 2000 - avgCpLoss);
});

// ---------------------------------------------------------------------------
// settingsKey
// ---------------------------------------------------------------------------

describe('settingsKey', () => {
  it('is a stable JSON of depth, multiPv, movetimeMs and engine name', () => {
    const key = settingsKey(SETTINGS, 'Stockfish 19');
    expect(JSON.parse(key)).toEqual({ depth: 12, multiPv: 2, movetimeMs: null, engineName: 'Stockfish 19' });
    expect(settingsKey({ ...SETTINGS, threads: 8, hashMb: 1024 }, 'Stockfish 19')).toBe(key);
  });

  it('distinguishes movetime, depth, multiPv and engine', () => {
    const base = settingsKey(SETTINGS, 'A');
    expect(settingsKey({ ...SETTINGS, movetimeMs: 500 }, 'A')).not.toBe(base);
    expect(settingsKey({ ...SETTINGS, depth: 13 }, 'A')).not.toBe(base);
    expect(settingsKey({ ...SETTINGS, multiPv: 3 }, 'A')).not.toBe(base);
    expect(settingsKey(SETTINGS, 'B')).not.toBe(base);
    expect(JSON.parse(settingsKey({ ...SETTINGS, movetimeMs: 500 }, 'A')).movetimeMs).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// analyzeGame: positions
// ---------------------------------------------------------------------------

describe('analyzeGame positions', () => {
  it('analyses every distinct position exactly once, including the start position', async () => {
    const engine = makeEngine();
    await analyzeGame(baseOptions({ engine: engine as unknown as UciEngine }));

    const expected = [GAME.initialFen, ...GAME.moves.map((m) => m.fenAfter)];
    expect(engine.analyse.mock.calls.map((c) => c[0])).toEqual(expected);
    expect(engine.analyse).toHaveBeenCalledWith(GAME.initialFen, { depth: 12, multiPv: 2 });
  });

  it('passes movetimeMs to the engine when set', async () => {
    const engine = makeEngine();
    await analyzeGame(
      baseOptions({ engine: engine as unknown as UciEngine, settings: { ...SETTINGS, movetimeMs: 250 } }),
    );
    expect(engine.analyse).toHaveBeenCalledWith(GAME.initialFen, { depth: 12, multiPv: 2, movetimeMs: 250 });
  });

  it('dedupes repeated FENs so a repeated position is analysed once', async () => {
    // After 1.Nf3 Nc6 2.Ng1 Nb8 the pieces are back home; script the last fenAfter to be identical
    // to the start FEN so the game contains a genuine repeat.
    const repeated = structuredClone(GAME);
    const last = repeated.moves[3]!;
    last.fenAfter = repeated.initialFen;
    parsePgnMock.mockReturnValue(repeated);

    const engine = makeEngine();
    const progress: number[] = [];
    const result = await analyzeGame(
      baseOptions({ engine: engine as unknown as UciEngine, onProgress: (p) => progress.push(p) }),
    );

    expect(engine.analyse).toHaveBeenCalledTimes(4);
    expect(new Set(engine.analyse.mock.calls.map((c) => c[0])).size).toBe(4);
    expect(progress).toEqual([0.25, 0.5, 0.75, 1]);
    // The repeated position is still used for the last move.
    expect(result.moves[3]!.evalAfter).toEqual(result.moves[0]!.evalBefore);
  });

  it('uses the cache: hits skip the engine, misses are stored', async () => {
    const cached = defaultAnalysis(GAME.moves[1]!.fenAfter, { type: 'cp', value: 123 });
    const cache = makeCache([cached]);
    const engine = makeEngine();

    const result = await analyzeGame(baseOptions({ engine: engine as unknown as UciEngine, cache }));

    expect(cache.get).toHaveBeenCalledTimes(5);
    expect(cache.get).toHaveBeenCalledWith(GAME.initialFen, 12, 2, ENGINE_NAME);
    expect(engine.analyse).toHaveBeenCalledTimes(4);
    expect(engine.analyse.mock.calls.map((c) => c[0])).not.toContain(cached.fen);
    expect(cache.set).toHaveBeenCalledTimes(4);
    for (const [stored] of cache.set.mock.calls) expect(stored.engine).toBe(ENGINE_NAME);
    expect(cache.store.size).toBe(5);
    // The cached analysis is what the move sees.
    expect(result.moves[1]!.evalAfter).toEqual({ type: 'cp', value: 123 });
    expect(result.moves[2]!.position).toBe(cached);
  });

  it('reports monotonic progress ending at 1, once per distinct position', async () => {
    const progress: number[] = [];
    await analyzeGame(baseOptions({ onProgress: (p) => progress.push(p) }));

    expect(progress).toHaveLength(5);
    for (let i = 1; i < progress.length; i++) expect(progress[i]!).toBeGreaterThan(progress[i - 1]!);
    expect(progress[0]).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// analyzeGame: moves, book and opening
// ---------------------------------------------------------------------------

describe('analyzeGame moves', () => {
  it('applies the book rule: once a move is out of book no later move is book', async () => {
    // Plies 1, 2 and 4 would be book moves according to the book; ply 3 is not.
    const book: FakeBook = {
      isBookMove: vi.fn((_soFar: string[], san: string) => san !== 'Ng1'),
      longestMatch: vi.fn(() => ({ opening: { eco: 'A04', name: 'Zukertort Opening' }, plies: 2 })),
    };

    const result = await analyzeGame(baseOptions({ book: book as unknown as OpeningBook }));

    expect(result.moves.map((m) => m.classification)).toEqual(['book', 'book', 'best', 'best']);
    expect(classifyMock.mock.calls.map(([ctx]) => ctx.isBook)).toEqual([true, true, false, false]);
    // Not even consulted once out of book.
    expect(book.isBookMove).toHaveBeenCalledTimes(3);
    expect(book.isBookMove).toHaveBeenNthCalledWith(1, [], 'Nf3');
    expect(book.isBookMove).toHaveBeenNthCalledWith(2, ['Nf3'], 'Nc6');
    expect(book.isBookMove).toHaveBeenNthCalledWith(3, ['Nf3', 'Nc6'], 'Ng1');

    expect(result.opening).toEqual({ eco: 'A04', name: 'Zukertort Opening', lastBookPly: 2 });
    expect(book.longestMatch).toHaveBeenLastCalledWith(['Nf3', 'Nc6', 'Ng1', 'Nb8']);
    // Opening ref present only on book moves.
    expect(result.moves[0]!.opening).toEqual({ eco: 'A04', name: 'Zukertort Opening' });
    expect(result.moves[1]!.opening).toEqual({ eco: 'A04', name: 'Zukertort Opening' });
    expect(result.moves[2]!.opening).toBeUndefined();
    expect(result.moves[3]!.opening).toBeUndefined();
  });

  it('lastBookPly is the last book move even when it runs past the longest named line', async () => {
    // 1.d4 Nf6 2.Nc3 is a prefix of several A45 lines, so Nc3 is a book move, but the longest line
    // that is exactly a prefix of the game is the 2-ply "Indian Defense".
    const book: FakeBook = {
      isBookMove: vi.fn((soFar: string[]) => soFar.length < 3),
      longestMatch: vi.fn((sans: string[]) =>
        sans.length >= 2 ? { opening: { eco: 'A45', name: 'Indian Defense' }, plies: 2 } : undefined,
      ),
    };
    parsePgnMock.mockReturnValue(makeGame(['d4', 'Nf6', 'Nc3', 'd6']));

    const result = await analyzeGame(baseOptions({ book: book as unknown as OpeningBook }));

    expect(result.moves.map((m) => m.classification)).toEqual(['book', 'book', 'book', 'best']);
    expect(result.opening).toEqual({ eco: 'A45', name: 'Indian Defense', lastBookPly: 3 });
    expect(result.white.counts.book + result.black.counts.book).toBe(result.opening.lastBookPly);
    expect(result.moves[2]!.opening).toEqual({ eco: 'A45', name: 'Indian Defense' });
  });

  it('falls back to an Unknown opening when nothing matches', async () => {
    const book: FakeBook = {
      isBookMove: vi.fn(() => false),
      longestMatch: vi.fn(() => undefined),
    };
    const result = await analyzeGame(baseOptions({ book: book as unknown as OpeningBook }));

    expect(result.opening).toEqual({ eco: '', name: 'Unknown', lastBookPly: 0 });
    expect(result.moves.every((m) => m.classification === 'best' && m.opening === undefined)).toBe(true);
  });

  it('builds the MoveContext and MoveAnalysis from engine lines', async () => {
    const start = GAME.initialFen;
    const afterNf3 = GAME.moves[0]!.fenAfter;
    const startAnalysis: PositionAnalysis = {
      fen: start,
      depth: 12,
      multipv: 2,
      engine: ENGINE_NAME,
      lines: [
        { multipv: 1, score: { type: 'cp', value: 35 }, depth: 12, pv: ['e2e4', 'e7e5', 'g1f3'] },
        { multipv: 2, score: { type: 'cp', value: 30 }, depth: 12, pv: ['d2d4', 'd7d5'] },
      ],
    };
    const afterNf3Analysis: PositionAnalysis = {
      fen: afterNf3,
      depth: 12,
      multipv: 2,
      engine: ENGINE_NAME,
      lines: [{ multipv: 1, score: { type: 'cp', value: 28 }, depth: 12, pv: ['d7d5'] }],
    };
    const engine = makeEngine({ [start]: startAnalysis, [afterNf3]: afterNf3Analysis });
    classifyMock.mockImplementation((ctx: MoveContext) =>
      detail({
        classification: ctx.ply === 1 ? 'good' : 'best',
        winProbBefore: 0.55,
        winProbAfter: ctx.ply === 1 ? 0.52 : 0.55,
        winProbLoss: ctx.ply === 1 ? 0.03 : 0,
        cpLoss: ctx.ply === 1 ? 7 : 0,
        isBest: ctx.ply !== 1,
        isSacrifice: ctx.ply === 2,
      }),
    );

    const result = await analyzeGame(baseOptions({ engine: engine as unknown as UciEngine, book: makeBook(0) as unknown as OpeningBook }));

    // MoveContext for ply 1.
    const ctx1 = classifyMock.mock.calls[0]![0];
    expect(ctx1).toMatchObject({
      ply: 1,
      color: 'w',
      san: 'Nf3',
      uci: 'g1f3',
      fenBefore: start,
      fenAfter: afterNf3,
      isBook: false,
      legalMoveCount: 20,
    });
    expect(ctx1.position).toEqual(startAnalysis);
    expect(ctx1.positionAfter).toEqual(afterNf3Analysis);
    expect(ctx1.previous).toBeUndefined();
    expect(classifyMock).toHaveBeenCalledWith(expect.anything(), DEFAULT_THRESHOLDS);

    // Ply 2 sees ply 1's detail as `previous`.
    const ctx2 = classifyMock.mock.calls[1]![0];
    expect(ctx2.previous).toEqual({ winProbLoss: 0.03, winProbBefore: 0.55, winProbAfter: 0.52 });
    expect(ctx2.position).toEqual(afterNf3Analysis);

    // MoveAnalysis for ply 1.
    const m1 = result.moves[0]!;
    expect(m1).toMatchObject({
      ply: 1,
      color: 'w',
      san: 'Nf3',
      uci: 'g1f3',
      evalBefore: { type: 'cp', value: 35 },
      evalAfter: { type: 'cp', value: 28 },
      winProbBefore: 0.55,
      winProbAfter: 0.52,
      winProbLoss: 0.03,
      cpLoss: 7,
      bestMove: { uci: 'e2e4', san: 'e4' },
      bestLine: ['e4', 'e5', 'Nf3'],
      secondBest: { move: { uci: 'd2d4', san: 'd4' }, score: { type: 'cp', value: 30 } },
      classification: 'good',
      clockSeconds: 600,
    });
    expect(m1.position).toEqual(startAnalysis);
    expect(m1.isSacrifice).toBeUndefined();

    // Ply 2: single engine line -> no secondBest; sacrifice flag copied from the classifier.
    const m2 = result.moves[1]!;
    expect(m2.bestMove).toEqual({ uci: 'd7d5', san: 'd5' });
    expect(m2.bestLine).toEqual(['d5']);
    expect(m2.secondBest).toBeUndefined();
    expect(m2.isSacrifice).toBe(true);
    expect(m2.clockSeconds).toBe(599);
  });

  it('truncates a best line at the first illegal continuation', async () => {
    const start = GAME.initialFen;
    const engine = makeEngine({
      [start]: {
        fen: start,
        depth: 12,
        multipv: 2,
        engine: ENGINE_NAME,
        lines: [{ multipv: 1, score: { type: 'cp', value: 10 }, depth: 12, pv: ['e2e4', 'e7e5', 'e1e3'] }],
      },
    });
    const result = await analyzeGame(baseOptions({ engine: engine as unknown as UciEngine }));
    expect(result.moves[0]!.bestLine).toEqual(['e4', 'e5']);
  });

  it('expresses a delivered checkmate as "mate 0" when the engine returns no lines', async () => {
    const mate = makeGame(['f3', 'e5', 'g4', 'Qh4#']);
    parsePgnMock.mockReturnValue(mate);
    const mated = mate.moves[3]!.fenAfter;
    const engine = makeEngine({
      [mated]: { fen: mated, depth: 12, multipv: 2, engine: ENGINE_NAME, lines: [] },
    });

    const result = await analyzeGame(baseOptions({ engine: engine as unknown as UciEngine }));
    // mate 0: the side to move (white) is checkmated. Never a cp score pretending to be an eval.
    expect(result.moves[3]!.evalAfter).toEqual({ type: 'mate', value: 0 });
    expect(JSON.parse(JSON.stringify(result.moves[3]!.evalAfter))).toEqual({ type: 'mate', value: 0 });
  });

  it('terminalScore: checkmate is mate 0, stalemate is cp 0', () => {
    expect(terminalScore('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3')).toEqual({ type: 'mate', value: 0 });
    expect(terminalScore('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')).toEqual({ type: 'cp', value: 0 });
  });
});

// ---------------------------------------------------------------------------
// analyzeGame: summaries, key moments, metadata
// ---------------------------------------------------------------------------

describe('analyzeGame summaries', () => {
  it('computes per-player summaries', async () => {
    const script: Record<number, ClassificationDetail> = {
      1: detail({ classification: 'book', winProbLoss: 0 }),
      2: detail({ classification: 'book', winProbLoss: 0 }),
      3: detail({ classification: 'blunder', winProbBefore: 0.5, winProbAfter: 0.2, winProbLoss: 0.3, cpLoss: 300 }),
      4: detail({ classification: 'inaccuracy', winProbBefore: 0.8, winProbAfter: 0.72, winProbLoss: 0.08, cpLoss: 40 }),
    };
    classifyMock.mockImplementation((ctx: MoveContext) => script[ctx.ply]!);

    const result = await analyzeGame(baseOptions());

    expect(result.white.username).toBe('alice');
    expect(result.white.rating).toBe(1500);
    expect(result.black.username).toBe('bob');
    expect(result.black.rating).toBe(1450);

    expect(result.white.accuracy).toBe(91.5);
    expect(result.black.accuracy).toBe(77.25);
    expect(gameAccuracyMock).toHaveBeenCalledTimes(2);
    const accInput = gameAccuracyMock.mock.calls[0]![0];
    expect(accInput).toEqual([
      { color: 'w', winProbLoss: 0, classification: 'book' },
      { color: 'b', winProbLoss: 0, classification: 'book' },
      { color: 'w', winProbLoss: 0.3, classification: 'blunder' },
      { color: 'b', winProbLoss: 0.08, classification: 'inaccuracy' },
    ]);
    expect(gameAccuracyMock).toHaveBeenCalledWith(expect.anything(), 'w', DEFAULT_THRESHOLDS);
    expect(gameAccuracyMock).toHaveBeenCalledWith(expect.anything(), 'b', DEFAULT_THRESHOLDS);

    // Average cp loss over non-book moves only.
    expect(result.white.averageCpLoss).toBe(300);
    expect(result.black.averageCpLoss).toBe(40);
    expect(estimateRatingMock).toHaveBeenCalledWith(300, 'blitz', DEFAULT_THRESHOLDS);
    expect(estimateRatingMock).toHaveBeenCalledWith(40, 'blitz', DEFAULT_THRESHOLDS);
    expect(result.white.estimatedRating).toBe(1700);
    expect(result.black.estimatedRating).toBe(1960);

    const zero = {
      brilliant: 0, great: 0, best: 0, excellent: 0, good: 0,
      book: 0, inaccuracy: 0, mistake: 0, miss: 0, blunder: 0,
    };
    expect(result.white.counts).toEqual({ ...zero, book: 1, blunder: 1 });
    expect(result.black.counts).toEqual({ ...zero, book: 1, inaccuracy: 1 });
  });

  it('averageCpLoss is 0 when a player has only book moves', async () => {
    classifyMock.mockImplementation(() => detail({ classification: 'book' }));
    const result = await analyzeGame(baseOptions({ book: makeBook(4) as unknown as OpeningBook }));
    expect(result.white.averageCpLoss).toBe(0);
    expect(result.black.averageCpLoss).toBe(0);
    expect(estimateRatingMock).toHaveBeenCalledWith(0, 'blitz', DEFAULT_THRESHOLDS);
  });

  it('omits rating when not supplied', async () => {
    const result = await analyzeGame(baseOptions({ whiteRating: undefined, blackRating: undefined }));
    expect('rating' in result.white).toBe(false);
    expect('rating' in result.black).toBe(false);
  });

  it('selects key moments by classification and swing, ordered by swing then ply, capped', async () => {
    const script: Record<number, ClassificationDetail> = {
      // Blunder: always a key moment, swing 0.3.
      1: detail({ classification: 'blunder', winProbBefore: 0.5, winProbAfter: 0.2, winProbLoss: 0.3 }),
      // Best with no swing: not a key moment.
      2: detail({ classification: 'best', winProbBefore: 0.8, winProbAfter: 0.8 }),
      // Best but a big swing (opponent blundered into it): key moment, swing 0.3 -> tie broken by ply.
      3: detail({ classification: 'best', winProbBefore: 0.2, winProbAfter: 0.5 }),
      // Great with a tiny swing: key moment by classification.
      4: detail({ classification: 'great', winProbBefore: 0.5, winProbAfter: 0.51 }),
    };
    classifyMock.mockImplementation((ctx: MoveContext) => script[ctx.ply]!);

    const all = await analyzeGame(baseOptions({ book: makeBook(0) as unknown as OpeningBook }));
    expect(all.keyMoments).toEqual([1, 3, 4]);

    const capped: Thresholds = { ...DEFAULT_THRESHOLDS, keyMoments: { minSwing: 0.15, max: 2 } };
    const result = await analyzeGame(baseOptions({ thresholds: capped, book: makeBook(0) as unknown as OpeningBook }));
    expect(result.keyMoments).toEqual([1, 3]);
  });

  it('selectKeyMoments honours minSwing and orders by swing', () => {
    const t: Thresholds = { ...DEFAULT_THRESHOLDS, keyMoments: { minSwing: 0.1, max: 8 } };
    const plies = selectKeyMoments(
      [
        { ply: 1, classification: 'good', winProbBefore: 0.5, winProbAfter: 0.45 },
        { ply: 2, classification: 'excellent', winProbBefore: 0.5, winProbAfter: 0.65 },
        { ply: 3, classification: 'miss', winProbBefore: 0.5, winProbAfter: 0.49 },
        { ply: 4, classification: 'mistake', winProbBefore: 0.5, winProbAfter: 0.38 },
      ],
      t,
    );
    expect(plies).toEqual([2, 4, 3]);
  });

  it('fills in settings, settingsKey and analyzedAt', async () => {
    const before = Date.now();
    const result = await analyzeGame(baseOptions());

    expect(result.gameId).toBe('game-1');
    expect(result.settings).toBe(SETTINGS);
    expect(result.settingsKey).toBe(settingsKey(SETTINGS, ENGINE_NAME));
    expect(parsePgnMock).toHaveBeenCalledWith('1. Nf3 Nc6 2. Ng1 Nb8');
    const at = Date.parse(result.analyzedAt);
    expect(Number.isNaN(at)).toBe(false);
    expect(at).toBeGreaterThanOrEqual(before - 1);
    expect(at).toBeLessThanOrEqual(Date.now() + 1);
    expect(result.analyzedAt).toBe(new Date(at).toISOString());
  });
});

// ---------------------------------------------------------------------------
// analyzeGame: abort
// ---------------------------------------------------------------------------

describe('analyzeGame abort', () => {
  it('stops the engine and rejects with AbortError when aborted mid-search', async () => {
    const controller = new AbortController();
    const engine = makeEngine();
    let resolveSecond: ((a: PositionAnalysis) => void) | undefined;
    engine.analyse.mockImplementation((fen: string) => {
      if (engine.analyse.mock.calls.length === 2) {
        // Abort while this search is pending; the search itself never finishes on its own.
        return new Promise<PositionAnalysis>((resolve) => {
          resolveSecond = resolve;
          queueMicrotask(() => controller.abort());
        });
      }
      return Promise.resolve(defaultAnalysis(fen));
    });
    const progress: number[] = [];

    const promise = analyzeGame(
      baseOptions({ engine: engine as unknown as UciEngine, signal: controller.signal, onProgress: (p) => progress.push(p) }),
    );
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    await expect(promise).rejects.toSatisfy(isAnalysisAbortError);

    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(engine.analyse).toHaveBeenCalledTimes(2);
    expect(progress).toEqual([0.2]);
    expect(classifyMock).not.toHaveBeenCalled();

    // The stopped search resolving late must not cause an unhandled rejection or further work.
    resolveSecond?.(defaultAnalysis(GAME.moves[0]!.fenAfter));
    await new Promise((r) => setTimeout(r, 0));
    expect(engine.analyse).toHaveBeenCalledTimes(2);
  });

  it('rejects immediately without searching when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const engine = makeEngine();

    await expect(
      analyzeGame(baseOptions({ engine: engine as unknown as UciEngine, signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.analyse).not.toHaveBeenCalled();
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it('rejects when aborted between positions (during a cache lookup)', async () => {
    const controller = new AbortController();
    const engine = makeEngine();
    const cache = makeCache();
    cache.get.mockImplementation(async (fen: string) => {
      if (cache.get.mock.calls.length === 3) controller.abort();
      return cache.store.get(fen);
    });

    await expect(
      analyzeGame(baseOptions({ engine: engine as unknown as UciEngine, cache, signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.analyse).toHaveBeenCalledTimes(2);
    // No search was running at abort time, so the engine was not stopped.
    expect(engine.stop).not.toHaveBeenCalled();
  });

  it('propagates engine errors unchanged', async () => {
    const engine = makeEngine();
    engine.analyse.mockRejectedValueOnce(new Error('engine crashed'));
    await expect(analyzeGame(baseOptions({ engine: engine as unknown as UciEngine }))).rejects.toThrow('engine crashed');
    expect(engine.stop).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// analyzeGame: cache depth normalisation and forced moves
// ---------------------------------------------------------------------------

describe('analyzeGame cache depth', () => {
  it('stores engine results under the REQUESTED depth so later lookups hit', async () => {
    const engine = makeEngine();
    // Engine reports the depth it actually reached (e.g. after stop() or under movetime).
    engine.analyse.mockImplementation(async (fen: string) => ({ ...defaultAnalysis(fen), depth: 7 }));
    const cache = makeCache();

    const result = await analyzeGame(baseOptions({ engine: engine as unknown as UciEngine, cache }));

    for (const [stored] of cache.set.mock.calls) expect(stored.depth).toBe(SETTINGS.depth);
    expect(result.moves[0]!.position.depth).toBe(SETTINGS.depth);
    // The lines keep the depth the engine reported them at.
    expect(result.moves[0]!.position.lines[0]!.depth).toBe(SETTINGS.depth);
  });
});

describe('forced moves', () => {
  // 1. e4 f5 2. Qh5+ g6 3. Qxg6+ hxg6: both Black replies are the only legal move.
  const FORCED_GAME = makeGame(['e4', 'f5', 'Qh5+', 'g6', 'Qxg6+', 'hxg6']);
  const afterQh5 = FORCED_GAME.moves[2]!.fenAfter; // Black to move, only g6
  const afterG6 = FORCED_GAME.moves[3]!.fenAfter;
  const afterQxg6 = FORCED_GAME.moves[4]!.fenAfter; // Black to move, only hxg6
  const afterHxg6 = FORCED_GAME.moves[5]!.fenAfter;

  /** What Stockfish returns for a single-legal-move position: an instant `cp 0` at depth 1. */
  function stockfishShortcut(fen: string, uci: string): PositionAnalysis {
    return { fen, depth: 1, multipv: SETTINGS.multiPv, engine: ENGINE_NAME, lines: [{ multipv: 1, score: { type: 'cp', value: 0 }, depth: 1, pv: [uci] }] };
  }

  it('forcedMove finds the only legal move', () => {
    expect(forcedMove(afterQh5)).toEqual({ uci: 'g7g6', fenAfter: afterG6 });
    expect(forcedMove(afterQxg6)).toEqual({ uci: 'h7g6', fenAfter: afterHxg6 });
    expect(forcedMove(FORCED_GAME.initialFen)).toBeUndefined();
  });

  it('never asks the engine about a forced position; its eval is the position after the forced move', async () => {
    parsePgnMock.mockReturnValue(FORCED_GAME);
    const engine = makeEngine({
      [afterQh5]: stockfishShortcut(afterQh5, 'g7g6'),
      [afterG6]: defaultAnalysis(afterG6, { type: 'cp', value: 350 }),
      [afterQxg6]: stockfishShortcut(afterQxg6, 'h7g6'),
      [afterHxg6]: defaultAnalysis(afterHxg6, { type: 'cp', value: -600 }),
    });
    const cache = makeCache();

    const result = await analyzeGame(baseOptions({ engine: engine as unknown as UciEngine, cache }));

    const asked = engine.analyse.mock.calls.map((c) => c[0]);
    expect(asked).not.toContain(afterQh5);
    expect(asked).not.toContain(afterQxg6);
    // Each real position is still analysed exactly once.
    expect(asked.filter((f) => f === afterG6)).toHaveLength(1);
    expect(asked.filter((f) => f === afterHxg6)).toHaveLength(1);

    const g6 = result.moves[3]!;
    expect(g6.evalBefore).toEqual({ type: 'cp', value: 350 });
    expect(g6.evalAfter).toEqual({ type: 'cp', value: 350 });
    expect(g6.position.lines).toHaveLength(1);
    expect(g6.position.lines[0]!.pv[0]).toBe('g7g6');
    expect(g6.bestMove).toEqual({ uci: 'g7g6', san: 'g6' });
    expect(g6.position.depth).toBe(SETTINGS.depth);

    const hxg6 = result.moves[5]!;
    expect(hxg6.evalBefore).toEqual({ type: 'cp', value: -600 });
    expect(hxg6.bestLine[0]).toBe('hxg6');
    // Qxg6+ (ply 5) is now measured against the true eval of the forced reply, not 0.00.
    expect(result.moves[4]!.evalAfter).toEqual({ type: 'cp', value: -600 });

    // Derived analyses are cached under the requested settings too.
    const storedForced = cache.set.mock.calls.map((c) => c[0]).filter((a) => a.fen === afterQh5);
    expect(storedForced).toHaveLength(1);
    expect(storedForced[0]!.depth).toBe(SETTINGS.depth);
    expect(storedForced[0]!.lines[0]!.score).toEqual({ type: 'cp', value: 350 });
  });

  it('deriveForcedMoveAnalysis shifts mate distance only when the forced mover is the mating side', () => {
    const forced = { uci: 'g7g6', fenAfter: afterG6 };
    const after = (score: EngineScore): PositionAnalysis => ({
      fen: afterG6, depth: 12, multipv: 2, engine: ENGINE_NAME,
      lines: [{ multipv: 1, score, depth: 12, pv: ['h5g6', 'h7g6'] }],
    });
    // Black is forced to play g6 and White mates in 3 afterwards: still mate in 3 for White.
    expect(deriveForcedMoveAnalysis(afterQh5, forced, after({ type: 'mate', value: 3 })).lines[0]!.score)
      .toEqual({ type: 'mate', value: 3 });
    // Black is forced to play g6 and then mates in 3 (as the side to move after White's reply):
    // one more Black move on the way, so mate in 4 for Black.
    expect(deriveForcedMoveAnalysis(afterQh5, forced, after({ type: 'mate', value: -3 })).lines[0]!.score)
      .toEqual({ type: 'mate', value: -4 });
    const derived = deriveForcedMoveAnalysis(afterQh5, forced, after({ type: 'cp', value: 42 }));
    expect(derived.lines[0]!.pv).toEqual(['g7g6', 'h5g6', 'h7g6']);
    expect(derived.fen).toBe(afterQh5);
  });

  it('deriveForcedMoveAnalysis scores a forced mating move as mate in 1', () => {
    // The engine returns no lines for a terminal position; the forced move Qg2 delivers mate.
    const fen = '8/8/8/8/8/8/5q1k/7K b - - 0 1';
    const forced = { uci: 'f2g2', fenAfter: '8/8/8/8/8/8/6qk/7K w - - 1 2' };
    expect(new Chess(forced.fenAfter).isCheckmate()).toBe(true);
    const terminalAfter: PositionAnalysis = { fen: forced.fenAfter, depth: 12, multipv: 2, engine: ENGINE_NAME, lines: [] };
    const derived = deriveForcedMoveAnalysis(fen, forced, terminalAfter);
    expect(derived.lines[0]!.score).toEqual({ type: 'mate', value: -1 });
    expect(derived.lines[0]!.pv).toEqual(['f2g2']);
  });
});
