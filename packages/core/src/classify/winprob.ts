/**
 * Score <-> win probability conversions.
 *
 * Engine scores are white POV (see types.ts). Win probabilities are 0..1 from the point of
 * view of a given colour (the mover, in the classifier).
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
 * "mate 0" (the side to move is checkmated) is sign-ambiguous once normalised to white POV.
 * It is read as a delivered mate for white (+mateCp) unless the value is literally -0.
 * `classifyMove` does not rely on this: it inspects the board with chess.js for terminal positions.
 */
export function scoreToCp(score: EngineScore, mateCp: number): number {
  if (score.type === 'cp') return score.value;
  const n = score.value;
  if (n === 0) return Object.is(n, -0) ? -mateCp : mateCp;
  const sign = n > 0 ? 1 : -1;
  return sign * (mateCp - Math.abs(n));
}

/** White-POV score -> win probability for `color`. */
export function scoreToWinProb(score: EngineScore, color: Color, t: Thresholds): number {
  return cpToWinProb(scoreToCp(scoreFromPov(score, color), t.winProb.mateCp), t.winProb.k);
}
