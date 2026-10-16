import type { Classification, Color, TimeClass } from '../types.js';
import type { Thresholds } from '../config/thresholds.js';

/** Per-move accuracy 0..100 from a win-prob loss (0..1). */
export function moveAccuracy(_winProbLoss: number, _t: Thresholds): number {
  throw new Error('not implemented');
}

export interface AccuracyInput {
  color: Color;
  winProbLoss: number;
  classification: Classification;
}

/** Mean of per-move accuracies for `color`; book moves count as 100. */
export function gameAccuracy(_moves: AccuracyInput[], _color: Color, _t: Thresholds): number {
  throw new Error('not implemented');
}

export function estimateRating(_averageCpLoss: number, _timeClass: TimeClass, _t: Thresholds): number {
  throw new Error('not implemented');
}
