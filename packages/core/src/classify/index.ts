/**
 * Move classification. Rules are specified in docs/ARCHITECTURE.md ("Classification rules").
 */
import type { Classification, Color, PositionAnalysis } from '../types.js';
import type { Thresholds } from '../config/thresholds.js';

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
  /** The opponent's previous move, from THAT mover's POV. */
  previous?: { winProbLoss: number; winProbBefore: number; winProbAfter: number };
}

export interface ClassificationDetail {
  classification: Classification;
  winProbBefore: number;
  winProbAfter: number;
  winProbLoss: number;
  cpLoss: number;
  isBest: boolean;
  isSacrifice: boolean;
}

export function classifyMove(_ctx: MoveContext, _t: Thresholds): ClassificationDetail {
  throw new Error('not implemented');
}
