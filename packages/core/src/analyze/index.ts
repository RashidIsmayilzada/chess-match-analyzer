/**
 * Game analysis orchestration. See docs/ARCHITECTURE.md (module "analyze").
 *
 * Pipeline: parse PGN -> analyse every distinct position once (memoised through an optional
 * PositionCache) -> classify every move -> per-player summaries -> key moments.
 */
import { Chess } from 'chess.js';
import {
  ALL_CLASSIFICATIONS,
  type AnalysisSettings,
  type Classification,
  type Color,
  type EngineLine,
  type EngineScore,
  type GameAnalysis,
  type MoveAnalysis,
  type MoveRef,
  type OpeningRef,
  type PlayerSummary,
  type PositionAnalysis,
  type TimeClass,
} from '../types.js';
import type { Thresholds } from '../config/thresholds.js';
import type { SearchSettings, UciEngine } from '../engine/index.js';
import type { OpeningBook } from '../openings/index.js';
import { parsePgn, type ParsedGame, type ParsedMove } from '../pgn/index.js';
import {
  classifyMove,
  estimateRating,
  gameAccuracy,
  type ClassificationDetail,
  type MoveContext,
} from '../classify/index.js';

/** Memoisation of engine results, e.g. backed by SQLite in the server. */
export interface PositionCache {
  get(fen: string, depth: number, multiPv: number, engine: string): Promise<PositionAnalysis | undefined>;
  set(analysis: PositionAnalysis): Promise<void>;
}

export interface AnalyzeGameOptions {
  gameId: string;
  pgn: string;
  timeClass: TimeClass;
  whiteUsername: string;
  blackUsername: string;
  whiteRating?: number;
  blackRating?: number;
  engine: UciEngine;
  book: OpeningBook;
  settings: AnalysisSettings;
  thresholds: Thresholds;
  cache?: PositionCache;
  /** progress 0..1, called after every analysed position. */
  onProgress?: (progress: number) => void;
  /** Abort signal; when aborted the engine is stopped and the promise rejects. */
  signal?: AbortSignal;
}

/** Deterministic key for an AnalysisSettings (depth, multiPv, movetime, engine name). */
export function settingsKey(settings: AnalysisSettings, engineName: string): string {
  return JSON.stringify({
    depth: settings.depth,
    multiPv: settings.multiPv,
    movetimeMs: settings.movetimeMs ?? null,
    engineName,
  });
}

// ---------------------------------------------------------------------------
// Abort handling
// ---------------------------------------------------------------------------

const ABORT_ERROR_NAME = 'AbortError';

function createAbortError(): Error {
  const err = new Error('Game analysis aborted');
  err.name = ABORT_ERROR_NAME;
  return err;
}

/** True when `err` is the rejection produced by an aborted `analyzeGame` call. */
export function isAnalysisAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === ABORT_ERROR_NAME;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createAbortError();
}

// ---------------------------------------------------------------------------
// chess.js helpers
// ---------------------------------------------------------------------------

function uciToMoveObject(uci: string): { from: string; to: string; promotion?: string } {
  const move: { from: string; to: string; promotion?: string } = {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
  };
  if (uci.length > 4) move.promotion = uci.slice(4, 5).toLowerCase();
  return move;
}

/** Apply a UCI move on a chess.js board; returns the SAN or undefined when illegal. */
function applyUci(chess: Chess, uci: string): string | undefined {
  try {
    return chess.move(uciToMoveObject(uci)).san;
  } catch {
    return undefined;
  }
}

/** SAN for a single UCI move played from `fen`; falls back to the UCI string if illegal. */
function uciToSan(fen: string, uci: string): string {
  return applyUci(new Chess(fen), uci) ?? uci;
}

/** SAN list for a principal variation played from `fen`; stops at the first illegal move. */
function pvToSan(fen: string, pv: readonly string[]): string[] {
  const chess = new Chess(fen);
  const sans: string[] = [];
  for (const uci of pv) {
    const san = applyUci(chess, uci);
    if (san === undefined) break;
    sans.push(san);
  }
  return sans;
}

function legalMoveCount(fen: string): number {
  return new Chess(fen).moves().length;
}

function sideToMove(fen: string): Color {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

interface ForcedMove {
  uci: string;
  fenAfter: string;
}

/** The only legal move in `fen`, when there is exactly one. */
export function forcedMove(fen: string): ForcedMove | undefined {
  const chess = new Chess(fen);
  const legal = chess.moves({ verbose: true });
  const only = legal[0];
  if (legal.length !== 1 || only === undefined) return undefined;
  chess.move(only);
  return { uci: `${only.from}${only.to}${only.promotion ?? ''}`, fenAfter: chess.fen() };
}

/**
 * A mate score seen from the position AFTER a forced move, expressed from the position before
 * it: when the side forced to move is the mating side, the forced move is one more move on the
 * way to mate. Mate distances are counted in moves of the mating side, so the mated side's
 * forced reply does not change the distance.
 */
function shiftMateDistance(score: EngineScore, mover: Color): EngineScore {
  if (score.type !== 'mate' || score.value === 0) return score;
  const winner: Color = score.value > 0 ? 'w' : 'b';
  return winner === mover ? { type: 'mate', value: score.value + Math.sign(score.value) } : score;
}

/**
 * Stockfish answers a position with exactly one legal move instantly with `score cp 0` and no
 * real search. The true eval of such a position is the eval of the position after the forced
 * move (scores are white POV, so no sign flip), which is what the classifier needs so the
 * forced move itself, and the moves around it, are not scored against a bogus 0.00.
 *
 * `after` is the engine analysis of `forced.fenAfter`; when it has no lines the position is
 * terminal (the forced move delivers mate or stalemate).
 */
export function deriveForcedMoveAnalysis(fen: string, forced: ForcedMove, after: PositionAnalysis): PositionAnalysis {
  const mover = sideToMove(fen);
  const best = after.lines[0];
  let line: EngineLine;
  if (best) {
    line = {
      multipv: 1,
      score: shiftMateDistance(best.score, mover),
      depth: best.depth,
      pv: [forced.uci, ...best.pv],
    };
  } else {
    const terminal = new Chess(forced.fenAfter);
    const score: EngineScore = terminal.isCheckmate()
      ? { type: 'mate', value: mover === 'w' ? 1 : -1 }
      : { type: 'cp', value: 0 };
    line = { multipv: 1, score, depth: after.depth, pv: [forced.uci] };
  }
  return { fen, depth: after.depth, multipv: after.multipv, engine: after.engine, lines: [line] };
}

/** Longest chain of consecutive forced moves followed before falling back to the raw engine result. */
const MAX_FORCED_CHAIN = 32;

/**
 * Score used when the engine returned no lines for a position (a terminal position).
 * Checkmate is `mate 0` (the side to move is checkmated, see `EngineScore`); any other terminal
 * state (stalemate, dead position, repetition, fifty moves) is a draw.
 */
export function terminalScore(fen: string): EngineScore {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) return { type: 'mate', value: 0 };
  return { type: 'cp', value: 0 };
}

function evalOf(analysis: PositionAnalysis): EngineScore {
  return analysis.lines[0]?.score ?? terminalScore(analysis.fen);
}

// ---------------------------------------------------------------------------
// Position analysis
// ---------------------------------------------------------------------------

/** Ordered list of distinct FENs that occur in the game (start position + after every move). */
function uniquePositions(game: ParsedGame): string[] {
  const seen = new Set<string>();
  const fens: string[] = [];
  for (const fen of [game.initialFen, ...game.moves.map((m) => m.fenAfter)]) {
    if (seen.has(fen)) continue;
    seen.add(fen);
    fens.push(fen);
  }
  return fens;
}

function searchSettingsFrom(settings: AnalysisSettings): SearchSettings {
  const search: SearchSettings = { depth: settings.depth, multiPv: settings.multiPv };
  if (settings.movetimeMs !== undefined) search.movetimeMs = settings.movetimeMs;
  return search;
}

/**
 * Analyse every FEN once, consulting the cache first. Reports progress after each position and
 * honours the abort signal: a running search is stopped and the returned promise rejects with
 * an error named "AbortError".
 */
async function analysePositions(
  fens: readonly string[],
  opts: AnalyzeGameOptions,
  engineName: string,
): Promise<Map<string, PositionAnalysis>> {
  const { engine, cache, onProgress, signal } = opts;
  const search = searchSettingsFrom(opts.settings);
  const results = new Map<string, PositionAnalysis>();
  const total = fens.length;

  // A promise that rejects as soon as the signal aborts, raced against the running search so
  // a cancellation is observed immediately instead of after the search completes on its own.
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    if (!signal) return;
    onAbort = () => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // Mark as handled: when nothing is racing against it an abort must not surface as an
  // unhandled rejection.
  aborted.catch(() => undefined);

  const runEngine = async (fen: string): Promise<PositionAnalysis> => {
    let raw: PositionAnalysis;
    try {
      raw = await Promise.race([engine.analyse(fen, search), aborted]);
    } catch (err) {
      if (isAnalysisAbortError(err)) engine.stop();
      throw err;
    }
    // The engine reports the depth it reached (lower after stop(), arbitrary under movetime);
    // the cache is keyed by the requested depth so later lookups with the same settings hit.
    return { ...raw, depth: search.depth };
  };

  /** Cache -> (forced move derivation | engine) -> cache, for one FEN. */
  const resolve = async (fen: string, chain: number): Promise<PositionAnalysis> => {
    const hit = cache ? await cache.get(fen, search.depth, search.multiPv, engineName) : undefined;
    throwIfAborted(signal);
    if (hit) return hit;

    let analysis: PositionAnalysis | undefined;
    const forced = chain < MAX_FORCED_CHAIN ? forcedMove(fen) : undefined;
    if (forced) {
      const after = results.get(forced.fenAfter) ?? (await resolve(forced.fenAfter, chain + 1));
      analysis = deriveForcedMoveAnalysis(fen, forced, after);
    } else {
      analysis = await runEngine(fen);
    }
    if (cache) await cache.set(analysis);
    return analysis;
  };

  try {
    throwIfAborted(signal);
    for (let i = 0; i < total; i++) {
      const fen = fens[i];
      if (fen === undefined) continue;
      throwIfAborted(signal);
      results.set(fen, await resolve(fen, 0));
      onProgress?.((i + 1) / total);
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Move walk
// ---------------------------------------------------------------------------

interface WalkResult {
  moves: MoveAnalysis[];
  opening: GameAnalysis['opening'];
}

const UNKNOWN_OPENING: OpeningRef = { eco: '', name: 'Unknown' };

function lineMove(fenBefore: string, pv: readonly string[]): MoveRef | undefined {
  const uci = pv[0];
  if (uci === undefined) return undefined;
  return { uci, san: uciToSan(fenBefore, uci) };
}

function buildMoveAnalysis(
  move: ParsedMove,
  position: PositionAnalysis,
  positionAfter: PositionAnalysis,
  detail: ClassificationDetail,
  isBook: boolean,
  opening: OpeningRef | undefined,
): MoveAnalysis {
  const best = position.lines[0];
  const second = position.lines[1];
  const bestMove = best ? lineMove(move.fenBefore, best.pv) : undefined;
  const secondMove = second ? lineMove(move.fenBefore, second.pv) : undefined;

  const analysis: MoveAnalysis = {
    ply: move.ply,
    color: move.color,
    san: move.san,
    uci: move.uci,
    fenBefore: move.fenBefore,
    fenAfter: move.fenAfter,
    evalBefore: evalOf(position),
    evalAfter: evalOf(positionAfter),
    winProbBefore: detail.winProbBefore,
    winProbAfter: detail.winProbAfter,
    winProbLoss: detail.winProbLoss,
    cpLoss: detail.cpLoss,
    bestMove: bestMove ?? { uci: '', san: '' },
    bestLine: best ? pvToSan(move.fenBefore, best.pv) : [],
    position,
    classification: detail.classification,
  };
  if (second && secondMove) analysis.secondBest = { move: secondMove, score: second.score };
  if (isBook && opening) analysis.opening = opening;
  if (detail.isSacrifice) analysis.isSacrifice = true;
  if (move.clockSeconds !== undefined) analysis.clockSeconds = move.clockSeconds;
  return analysis;
}

function walkMoves(
  game: ParsedGame,
  analyses: ReadonlyMap<string, PositionAnalysis>,
  book: OpeningBook,
  t: Thresholds,
): WalkResult {
  const moves: MoveAnalysis[] = [];
  const sans: string[] = [];
  let inBook = true;
  let lastBookPly = 0;
  let previous: MoveContext['previous'];

  for (const move of game.moves) {
    const position = analyses.get(move.fenBefore);
    const positionAfter = analyses.get(move.fenAfter);
    if (!position || !positionAfter) {
      throw new Error(`Missing engine analysis for ply ${move.ply}`);
    }

    // Book moves stop at the first non-book move: once out of book, never back in.
    // Snapshots are handed to the book so a retained reference never sees later moves.
    const isBook = inBook && book.isBookMove([...sans], move.san);
    if (isBook) lastBookPly = move.ply;
    else inBook = false;
    sans.push(move.san);
    const opening = isBook ? book.longestMatch([...sans])?.opening : undefined;

    const ctx: MoveContext = {
      ply: move.ply,
      color: move.color,
      san: move.san,
      uci: move.uci,
      fenBefore: move.fenBefore,
      fenAfter: move.fenAfter,
      position,
      positionAfter,
      isBook,
      legalMoveCount: legalMoveCount(move.fenBefore),
    };
    if (previous) ctx.previous = previous;

    const detail = classifyMove(ctx, t);
    moves.push(buildMoveAnalysis(move, position, positionAfter, detail, isBook, opening));
    previous = {
      winProbLoss: detail.winProbLoss,
      winProbBefore: detail.winProbBefore,
      winProbAfter: detail.winProbAfter,
    };
  }

  // Name and ECO come from the longest NAMED line the game follows; `lastBookPly` is the ply of
  // the last move classified as book, which can run past that line (the book knows prefixes of
  // longer lines whose own name only applies once they are complete).
  const match = book.longestMatch([...sans]);
  const opening: GameAnalysis['opening'] = match
    ? { eco: match.opening.eco, name: match.opening.name, lastBookPly }
    : { ...UNKNOWN_OPENING, lastBookPly };

  return { moves, opening };
}

// ---------------------------------------------------------------------------
// Summaries and key moments
// ---------------------------------------------------------------------------

function emptyCounts(): Record<Classification, number> {
  const counts = {} as Record<Classification, number>;
  for (const c of ALL_CLASSIFICATIONS) counts[c] = 0;
  return counts;
}

function summarisePlayer(
  color: Color,
  username: string,
  rating: number | undefined,
  moves: readonly MoveAnalysis[],
  timeClass: TimeClass,
  t: Thresholds,
): PlayerSummary {
  const counts = emptyCounts();
  let cpLossSum = 0;
  let nonBook = 0;
  for (const m of moves) {
    if (m.color !== color) continue;
    counts[m.classification] += 1;
    if (m.classification !== 'book') {
      cpLossSum += m.cpLoss;
      nonBook += 1;
    }
  }
  const averageCpLoss = nonBook > 0 ? cpLossSum / nonBook : 0;
  const accuracy = gameAccuracy(
    moves.map((m) => ({ color: m.color, winProbLoss: m.winProbLoss, classification: m.classification })),
    color,
    t,
  );

  const summary: PlayerSummary = {
    username,
    accuracy,
    estimatedRating: estimateRating(averageCpLoss, timeClass, t),
    averageCpLoss,
    counts,
  };
  if (rating !== undefined) summary.rating = rating;
  return summary;
}

/** Classifications that always make a move a key moment, regardless of swing size. */
const KEY_MOMENT_CLASSIFICATIONS: ReadonlySet<Classification> = new Set<Classification>([
  'brilliant',
  'great',
  'miss',
  'blunder',
]);

type KeyMomentInput = Pick<MoveAnalysis, 'ply' | 'classification' | 'winProbBefore' | 'winProbAfter'>;

/**
 * Plies that are key moments: brilliant / great / miss / blunder moves plus any move whose
 * win-prob swing is at least `keyMoments.minSwing`; capped at `keyMoments.max`, ordered by
 * swing size (descending) then ply.
 */
export function selectKeyMoments(moves: readonly KeyMomentInput[], t: Thresholds): number[] {
  return moves
    .map((m) => ({
      ply: m.ply,
      swing: Math.abs(m.winProbBefore - m.winProbAfter),
      classification: m.classification,
    }))
    .filter((m) => KEY_MOMENT_CLASSIFICATIONS.has(m.classification) || m.swing >= t.keyMoments.minSwing)
    .sort((a, b) => b.swing - a.swing || a.ply - b.ply)
    .slice(0, t.keyMoments.max)
    .map((m) => m.ply);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function analyzeGame(opts: AnalyzeGameOptions): Promise<GameAnalysis> {
  const { engine, book, settings, thresholds, timeClass } = opts;
  throwIfAborted(opts.signal);

  const game = parsePgn(opts.pgn);
  const engineName = engine.name;
  const analyses = await analysePositions(uniquePositions(game), opts, engineName);

  const { moves, opening } = walkMoves(game, analyses, book, thresholds);

  return {
    gameId: opts.gameId,
    settings,
    settingsKey: settingsKey(settings, engineName),
    moves,
    white: summarisePlayer('w', opts.whiteUsername, opts.whiteRating, moves, timeClass, thresholds),
    black: summarisePlayer('b', opts.blackUsername, opts.blackRating, moves, timeClass, thresholds),
    opening,
    keyMoments: selectKeyMoments(moves, thresholds),
    analyzedAt: new Date().toISOString(),
  };
}
