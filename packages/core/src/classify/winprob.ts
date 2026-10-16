import type { Color, EngineScore } from '../types.js';
import type { Thresholds } from '../config/thresholds.js';

/** Centipawns (any POV) -> win probability 0..1 for that POV. */
export function cpToWinProb(_cp: number, _k: number): number {
  throw new Error('not implemented');
}

/** Convert a white-POV score to the given colour's POV. */
export function scoreFromPov(_score: EngineScore, _color: Color): EngineScore {
  throw new Error('not implemented');
}

/** Score -> centipawn-equivalent number (mate becomes +-mateCp adjusted by distance). */
export function scoreToCp(_score: EngineScore, _mateCp: number): number {
  throw new Error('not implemented');
}

/** White-POV score -> win probability for `color`. */
export function scoreToWinProb(_score: EngineScore, _color: Color, _t: Thresholds): number {
  throw new Error('not implemented');
}
