/**
 * Move classification. Rules are specified in docs/ARCHITECTURE.md ("Classification rules").
 *
 * Order of evaluation: book -> brilliant -> great -> miss -> bands. Every number comes from
 * `Thresholds`; scores are converted to the mover's POV before anything is compared.
 */
import { Chess } from 'chess.js';
import type { Classification, Color, PositionAnalysis } from '../types.js';
import type { Thresholds } from '../config/thresholds.js';
import { cpToWinProb, scoreFromPov, scoreToCp } from './winprob.js';
import { captureExchange, detectSacrifice, type CaptureExchange, type SacrificeResult } from './sacrifice.js';

export * from './winprob.js';
export * from './sacrifice.js';
export * from './accuracy.js';

export interface MoveContext {
  ply: number;
  color: Color;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  /** Engine lines for fenBefore (white POV). */
  position: PositionAnalysis;
  /** Engine lines for fenAfter (white POV). */
  positionAfter: PositionAnalysis;
  isBook: boolean;
  legalMoveCount: number;
  /** The opponent's previous move; win probabilities from THAT mover's POV. */
  previous?: PreviousMove;
}

export interface PreviousMove {
  winProbLoss: number;
  winProbBefore: number;
  winProbAfter: number;
  uci: string;
  san: string;
  isCapture: boolean;
  /** Destination square of the previous move, e.g. "d2". */
  toSquare: string;
}

export interface ClassificationDetail {
  classification: Classification;
  winProbBefore: number;
  winProbAfter: number;
  winProbLoss: number;
  cpLoss: number;
  isBest: boolean;
  isSacrifice: boolean;
  /** Gross material offered (`SacrificeResult.grossValue`), present when `isSacrifice`. */
  sacrificeValue?: number;
}

/** Everything the individual rules need, computed once per move. All numbers are mover POV. */
export interface MoveEvaluation {
  color: Color;
  /** Centipawn equivalent of the best line before the move (mates mapped through `mateCp`). */
  cpBefore: number;
  /** Centipawn equivalent of the best line after the move. */
  cpAfter: number;
  winProbBefore: number;
  winProbAfter: number;
  /** `max(0, winProbBefore - winProbAfter)`. */
  winProbLoss: number;
  /** `max(0, cpBefore - cpAfter)`. */
  cpLoss: number;
  /** Played the engine's top move, or reached an eval at least as good as the top line. */
  isBest: boolean;
  /** Mover win probability of the second engine line, when MultiPV >= 2. */
  winProbSecondBest?: number;
  /** The move checkmated the opponent (mate-in-one). */
  deliversMate: boolean;
  /** After the move the mover has a forced mate (delivered, or seen by the engine). */
  moverMatesAfter: boolean;
  legalMoveCount: number;
  /** Win-prob loss of the opponent's previous move, when known. */
  previousLoss?: number;
  sacrifice: SacrificeResult;
  /** Capture info: is it a capture, and what the exchange it starts wins for the mover. */
  capture: CaptureExchange;
  /** A capture on the square where the opponent's previous move captured. */
  isRecapture: boolean;
}

/**
 * Terminal positions (no engine lines, or "mate 0") are resolved on the board: a delivered mate is
 * +mateCp for the mover, a drawn position (stalemate, insufficient material, fifty moves) is 0.
 */
function resolveCpAfter(ctx: MoveContext, cpBefore: number, mateCp: number): { cpAfter: number; deliversMate: boolean } {
  const line = ctx.positionAfter.lines[0];
  const terminal = !line || (line.score.type === 'mate' && line.score.value === 0);
  if (terminal) {
    const board = new Chess(ctx.fenAfter);
    if (board.isCheckmate()) return { cpAfter: mateCp, deliversMate: true };
    if (board.isDraw()) return { cpAfter: 0, deliversMate: false };
    // No engine output (or a "mate 0" that the board does not confirm) and the game goes on:
    // no information, so assume nothing was lost.
    return { cpAfter: cpBefore, deliversMate: false };
  }
  return { cpAfter: scoreToCp(scoreFromPov(line.score, ctx.color), mateCp), deliversMate: false };
}

/** Compute win probabilities, losses, best-move status and sacrifice info for a move. */
export function evaluateMove(ctx: MoveContext, t: Thresholds): MoveEvaluation {
  const { k, mateCp } = t.winProb;
  const mover = ctx.color;

  const best = ctx.position.lines[0];
  const cpBefore = best ? scoreToCp(scoreFromPov(best.score, mover), mateCp) : 0;
  const second = ctx.position.lines[1];
  const winProbSecondBest = second ? cpToWinProb(scoreToCp(scoreFromPov(second.score, mover), mateCp), k) : undefined;

  const { cpAfter, deliversMate } = resolveCpAfter(ctx, cpBefore, mateCp);
  const afterLine = ctx.positionAfter.lines[0];
  const engineSeesMateForMover =
    afterLine !== undefined && afterLine.score.type === 'mate' && scoreFromPov(afterLine.score, mover).value > 0;

  const winProbBefore = cpToWinProb(cpBefore, k);
  const winProbAfter = cpToWinProb(cpAfter, k);
  const capture = captureExchange(ctx.fenBefore, ctx.uci);

  // Centipawn loss on clamped evals: beyond +-evalClampCp a position is simply "decisive" and
  // eval noise there must not count as material lost (see Thresholds.rating.evalClampCp).
  const clampCp = (cp: number): number => Math.max(-t.rating.evalClampCp, Math.min(t.rating.evalClampCp, cp));

  return {
    color: mover,
    cpBefore,
    cpAfter,
    winProbBefore,
    winProbAfter,
    winProbLoss: Math.max(0, winProbBefore - winProbAfter),
    cpLoss: Math.max(0, clampCp(cpBefore) - clampCp(cpAfter)),
    isBest: (best !== undefined && ctx.uci === best.pv[0]) || cpAfter >= cpBefore,
    winProbSecondBest,
    deliversMate,
    moverMatesAfter: deliversMate || engineSeesMateForMover,
    legalMoveCount: ctx.legalMoveCount,
    previousLoss: ctx.previous?.winProbLoss,
    sacrifice: detectSacrifice(ctx.fenBefore, ctx.uci),
    capture,
    isRecapture:
      capture.isCapture && ctx.previous !== undefined && ctx.previous.isCapture && ctx.previous.toSquare === ctx.uci.slice(2, 4),
  };
}

/**
 * Rule 3: a sound sacrifice of at least an exchange from a position that was not yet decided.
 * A free capture (the captured piece was hanging and nothing of the mover's is left en prise)
 * nets a sacrifice value of 0, so it never qualifies.
 */
export function isBrilliant(ev: MoveEvaluation, t: Thresholds): boolean {
  const b = t.brilliant;
  if (ev.winProbLoss > b.maxLossFromBest) return false;
  if (ev.sacrifice.value < b.minSacrificeValue) return false;
  const alreadyDecided = ev.winProbBefore > b.maxWinProbBefore;
  if (alreadyDecided && !(b.allowWhenWinningIfMate && ev.moverMatesAfter)) return false;
  if (ev.winProbAfter < b.minWinProbAfter) return false;
  if (b.excludeMateInOne && ev.deliversMate) return false;
  return true;
}

/**
 * Rule 4: the only good move, found in a position that was still in the balance. Obvious captures
 * (recaptures, taking a hanging piece) are never great.
 */
export function isGreat(ev: MoveEvaluation, t: Thresholds): boolean {
  const g = t.great;
  if (ev.winProbLoss > g.maxLossFromBest || !ev.isBest) return false;
  if (g.excludeRecaptures && ev.isRecapture) return false;
  if (g.excludeFreeCaptures && ev.capture.isCapture && ev.capture.gain > 0) return false;
  if (ev.winProbSecondBest === undefined) return false;
  if (ev.winProbBefore - ev.winProbSecondBest < g.minGapToSecondBest) return false;
  if (ev.winProbBefore < g.minWinProbBefore || ev.winProbBefore > g.maxWinProbBefore) return false;
  if (g.excludeForcedMoves && ev.legalMoveCount <= 1) return false;
  return true;
}

/** Rule 5: the opponent just blundered and the mover handed a large share of it straight back. */
export function isMiss(ev: MoveEvaluation, t: Thresholds): boolean {
  const m = t.miss;
  if (ev.previousLoss === undefined || ev.previousLoss < m.minOpponentLoss) return false;
  if (ev.winProbLoss < m.minOwnLoss) return false;
  return ev.winProbLoss / ev.previousLoss >= m.minGiveBackFraction;
}

/** Rule 6: best / excellent / good / inaccuracy / mistake / blunder by win-prob loss. */
export function bandFor(ev: MoveEvaluation, t: Thresholds): Classification {
  if (ev.isBest) return 'best';
  const loss = ev.winProbLoss;
  const b = t.bands;
  if (loss <= b.excellent) return 'excellent';
  if (loss <= b.good) return 'good';
  if (loss <= b.inaccuracy) return 'inaccuracy';
  if (loss <= b.mistake) return 'mistake';
  return 'blunder';
}

export function classifyMove(ctx: MoveContext, t: Thresholds): ClassificationDetail {
  const ev = evaluateMove(ctx, t);
  let classification: Classification;
  if (ctx.isBook) classification = 'book';
  else if (isBrilliant(ev, t)) classification = 'brilliant';
  else if (isGreat(ev, t)) classification = 'great';
  else if (isMiss(ev, t)) classification = 'miss';
  else classification = bandFor(ev, t);

  const detail: ClassificationDetail = {
    classification,
    winProbBefore: ev.winProbBefore,
    winProbAfter: ev.winProbAfter,
    winProbLoss: ev.winProbLoss,
    cpLoss: ev.cpLoss,
    isBest: ev.isBest,
    isSacrifice: ev.sacrifice.isSacrifice,
  };
  if (ev.sacrifice.isSacrifice) detail.sacrificeValue = ev.sacrifice.grossValue;
  return detail;
}
