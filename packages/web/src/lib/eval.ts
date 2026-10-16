import type { Color, EngineScore } from '@chess-analyzer/core';
import { DEFAULT_THRESHOLDS } from '@chess-analyzer/core/thresholds';

/** Graph / bar clamp in pawns. Mate scores are shown as +-GRAPH_CLAMP. */
export const GRAPH_CLAMP = 10;

/** Lichess sigmoid steepness for cp -> win probability. Used only for eval-bar geometry. */
const BAR_K = 0.00368208;

/**
 * Centipawn magnitude that core treats as equivalent to a mate. Analyses produced before core
 * switched to `mate 0` stored a delivered checkmate as `cp +-MATE_CP`; those are still read as mates.
 */
const MATE_CP = DEFAULT_THRESHOLDS.winProb.mateCp;

function other(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

/**
 * True when the score describes a position in which mate has already been delivered:
 * `mate 0` (the side to move is checkmated), or a legacy `cp` at +-MATE_CP.
 */
export function isDeliveredMate(score: EngineScore): boolean {
  if (score.type === 'mate') return score.value === 0;
  return Math.abs(score.value) >= MATE_CP;
}

/**
 * Side that has won (delivered mate) or is winning (forced mate) according to `score`.
 * For `mate 0` the winner is the side NOT to move, so `sideToMove` is needed; without it the
 * winner of a `mate 0` is unknown and undefined is returned.
 */
export function mateWinner(score: EngineScore, sideToMove?: Color): Color | undefined {
  if (score.type === 'mate') {
    if (score.value === 0) return sideToMove === undefined ? undefined : other(sideToMove);
    return score.value > 0 ? 'w' : 'b';
  }
  if (Math.abs(score.value) >= MATE_CP) return score.value > 0 ? 'w' : 'b';
  return undefined;
}

/** White-POV score in pawns, clamped to +-GRAPH_CLAMP. Mate = +-GRAPH_CLAMP. */
export function scoreToPawns(score: EngineScore, sideToMove?: Color): number {
  if (score.type === 'mate' || isDeliveredMate(score)) {
    const winner = mateWinner(score, sideToMove);
    if (winner === undefined) return 0;
    return winner === 'w' ? GRAPH_CLAMP : -GRAPH_CLAMP;
  }
  const pawns = score.value / 100;
  return Math.max(-GRAPH_CLAMP, Math.min(GRAPH_CLAMP, pawns));
}

/** "+1.3", "-0.4", "M5", "-M3", "0.0"; a delivered mate is "1-0" / "0-1" (or "#" when the winner is unknown). */
export function formatScore(score: EngineScore, sideToMove?: Color): string {
  if (isDeliveredMate(score)) {
    const winner = mateWinner(score, sideToMove);
    return winner === undefined ? '#' : winner === 'w' ? '1-0' : '0-1';
  }
  if (score.type === 'mate') {
    return score.value > 0 ? `M${score.value}` : `-M${Math.abs(score.value)}`;
  }
  const pawns = score.value / 100;
  const abs = Math.abs(pawns).toFixed(1);
  if (pawns > 0) return `+${abs}`;
  if (pawns < 0) return `-${abs}`;
  return '0.0';
}

/** Short label for the eval bar (no sign for cp, "M5" for mates, "#" for a delivered mate). */
export function formatBarLabel(score: EngineScore): string {
  if (isDeliveredMate(score)) return '#';
  if (score.type === 'mate') return `M${Math.abs(score.value)}`;
  return Math.abs(score.value / 100).toFixed(1);
}

/** Percentage of the eval bar (0..100) that should be white, from a white-POV score. */
export function whiteBarPercent(score: EngineScore, sideToMove?: Color): number {
  if (score.type === 'mate' || isDeliveredMate(score)) {
    const winner = mateWinner(score, sideToMove);
    if (winner === undefined) return 50;
    return winner === 'w' ? 100 : 0;
  }
  const winProb = 1 / (1 + Math.exp(-BAR_K * score.value));
  const pct = winProb * 100;
  return Math.max(3, Math.min(97, pct));
}

/** True when the score favours white (>0), false when black; null when equal. */
export function scoreSign(score: EngineScore, sideToMove?: Color): 1 | -1 | 0 {
  if (isDeliveredMate(score)) {
    const winner = mateWinner(score, sideToMove);
    return winner === undefined ? 0 : winner === 'w' ? 1 : -1;
  }
  if (score.value > 0) return 1;
  if (score.value < 0) return -1;
  return 0;
}
