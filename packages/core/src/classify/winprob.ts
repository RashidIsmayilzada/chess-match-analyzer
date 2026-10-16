/**
 * Score <-> win probability conversions.
 *
 * Engine scores are white POV (see types.ts). Win probabilities are 0..1 from the point of
 * view of a given colour (the mover, in the classifier).
 *
 * "mate 0" means the side to move has been checkmated. A zero carries no sign, so the winner is
 * not part of the score: it is whoever is NOT to move in that position. Converting a `mate 0`
 * therefore needs the side to move (`positionScoreToCp`, `scoreToWinProb(..., sideToMove)`);
 * `scoreToCp` alone cannot resolve it and throws rather than guess. `classifyMove` never relies
 * on this: it inspects the board with chess.js for terminal positions.
 */
import type { Color, EngineScore } from '../types.js';
import type { Thresholds } from '../config/thresholds.js';

/**
 * Centipawns (any POV) -> win probability 0..1 for that POV.
 *
 * Logistic curve `1 / (1 + exp(-k * cp))`, which is the Lichess formula
 * `50 + 50 * (2 / (1 + exp(-k * cp)) - 1)` expressed on 0..1. Clamped to 0..1 (the raw
 * sigmoid already is, but +-Infinity and float noise are guarded).
 */
export function cpToWinProb(cp: number, k: number): number {
  if (Number.isNaN(cp)) return 0.5;
  const p = 1 / (1 + Math.exp(-k * cp));
  return p < 0 ? 0 : p > 1 ? 1 : p;
}

/** True for `mate 0`: the side to move has been checkmated. */
export function isMateZero(score: EngineScore): boolean {
  return score.type === 'mate' && score.value === 0;
}

/** Convert a white-POV score to the given colour's POV (negate for black). Never yields -0. */
export function scoreFromPov(score: EngineScore, color: Color): EngineScore {
  if (color === 'w') return { type: score.type, value: score.value };
  return { type: score.type, value: score.value === 0 ? 0 : -score.value };
}

/** Alias of {@link scoreFromPov}, named as in docs/ARCHITECTURE.md. */
export const scoreFromMoverPov = scoreFromPov;

/**
 * Score -> centipawn-equivalent number.
 *
 * cp passes through. A mate in n becomes `sign * (mateCp - |n|)`, so every mate dominates every
 * cp score and closer mates are bigger (mate 1 > mate 3; mate -1 < mate -3).
 *
 * `mate 0` (the side to move is checkmated) has no sign and cannot be converted without knowing
 * the side to move: use {@link positionScoreToCp}. Passing it here throws a RangeError so a
 * terminal position is never silently read as a win for the wrong side.
 */
export function scoreToCp(score: EngineScore, mateCp: number): number {
  if (score.type === 'cp') return score.value;
  const n = score.value;
  if (n === 0) {
    throw new RangeError('scoreToCp: "mate 0" has no side; use positionScoreToCp(score, sideToMove, mateCp)');
  }
  const sign = n > 0 ? 1 : -1;
  return sign * (mateCp - Math.abs(n));
}

/**
 * White-POV score of a position -> white-POV centipawn equivalent, resolving `mate 0` with the
 * side to move of that position (the side to move is the mated side, so `mate 0` with white to
 * move is `-mateCp`).
 */
export function positionScoreToCp(score: EngineScore, sideToMove: Color, mateCp: number): number {
  if (isMateZero(score)) return sideToMove === 'w' ? -mateCp : mateCp;
  return scoreToCp(score, mateCp);
}

/**
 * White-POV score -> win probability for `color`.
 *
 * `sideToMove` is only needed for `mate 0` (see module comment); without it a `mate 0` throws.
 */
export function scoreToWinProb(score: EngineScore, color: Color, t: Thresholds, sideToMove?: Color): number {
  const { k, mateCp } = t.winProb;
  if (isMateZero(score)) {
    if (sideToMove === undefined) {
      throw new RangeError('scoreToWinProb: "mate 0" needs the side to move to know who delivered the mate');
    }
    const whiteCp = positionScoreToCp(score, sideToMove, mateCp);
    return cpToWinProb(color === 'w' ? whiteCp : -whiteCp, k);
  }
  return cpToWinProb(scoreToCp(scoreFromPov(score, color), mateCp), k);
}
