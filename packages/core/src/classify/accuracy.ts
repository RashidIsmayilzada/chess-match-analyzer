/**
 * Accuracy and rating estimates. Formulas are specified in docs/ARCHITECTURE.md; every constant
 * comes from `Thresholds`.
 */
import type { Classification, Color, TimeClass } from '../types.js';
import type { Thresholds } from '../config/thresholds.js';

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Per-move accuracy 0..100 from a win-prob loss (0..1), Lichess style:
 * `a * exp(b * lossPercent) + c`, clamped to 0..100. A negative loss counts as 0 (a move that
 * improves the eval is simply perfect); NaN yields 0.
 */
export function moveAccuracy(winProbLoss: number, t: Thresholds): number {
  if (Number.isNaN(winProbLoss)) return 0;
  const lossPct = Math.max(0, winProbLoss) * 100;
  const { a, b, c } = t.accuracy;
  return clamp(a * Math.exp(b * lossPct) + c, 0, 100);
}

export interface AccuracyInput {
  color: Color;
  winProbLoss: number;
  classification: Classification;
}

/** Mean of per-move accuracies for `color`; book moves count as 100. No moves -> 100. */
export function gameAccuracy(moves: AccuracyInput[], color: Color, t: Thresholds): number {
  let sum = 0;
  let n = 0;
  for (const m of moves) {
    if (m.color !== color) continue;
    sum += m.classification === 'book' ? 100 : moveAccuracy(m.winProbLoss, t);
    n += 1;
  }
  if (n === 0) return 100;
  return clamp(sum / n, 0, 100);
}

/** `clamp(base - slope * averageCpLoss, min, max)` for the time class, rounded to a whole rating. */
export function estimateRating(averageCpLoss: number, timeClass: TimeClass, t: Thresholds): number {
  const { base, slope } = t.rating.byTimeClass[timeClass];
  const loss = Number.isFinite(averageCpLoss) ? Math.max(0, averageCpLoss) : 0;
  return Math.round(clamp(base - slope * loss, t.rating.min, t.rating.max));
}
