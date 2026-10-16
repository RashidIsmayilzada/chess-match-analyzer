import type { EngineScore } from '@chess-analyzer/core';

/** Graph / bar clamp in pawns. Mate scores are shown as +-GRAPH_CLAMP. */
export const GRAPH_CLAMP = 10;

/** Lichess sigmoid steepness for cp -> win probability. Used only for eval-bar geometry. */
const BAR_K = 0.00368208;

/** White-POV score in pawns, clamped to +-GRAPH_CLAMP. Mate = +-GRAPH_CLAMP. */
export function scoreToPawns(score: EngineScore): number {
  if (score.type === 'mate') {
    if (score.value === 0) return 0;
    return score.value > 0 ? GRAPH_CLAMP : -GRAPH_CLAMP;
  }
  const pawns = score.value / 100;
  return Math.max(-GRAPH_CLAMP, Math.min(GRAPH_CLAMP, pawns));
}

/** "+1.3", "-0.4", "M5", "-M3", "0.0". */
export function formatScore(score: EngineScore): string {
  if (score.type === 'mate') {
    if (score.value === 0) return '#';
    return score.value > 0 ? `M${score.value}` : `-M${Math.abs(score.value)}`;
  }
  const pawns = score.value / 100;
  const abs = Math.abs(pawns).toFixed(1);
  if (pawns > 0) return `+${abs}`;
  if (pawns < 0) return `-${abs}`;
  return '0.0';
}

/** Short label for the eval bar (no sign for cp, "M5" for mates). */
export function formatBarLabel(score: EngineScore): string {
  if (score.type === 'mate') {
    if (score.value === 0) return '#';
    return `M${Math.abs(score.value)}`;
  }
  return Math.abs(score.value / 100).toFixed(1);
}

/** Percentage of the eval bar (0..100) that should be white, from a white-POV score. */
export function whiteBarPercent(score: EngineScore): number {
  if (score.type === 'mate') {
    if (score.value === 0) return 50;
    return score.value > 0 ? 100 : 0;
  }
  const winProb = 1 / (1 + Math.exp(-BAR_K * score.value));
  const pct = winProb * 100;
  return Math.max(3, Math.min(97, pct));
}

/** True when the score favours white (>0), false when black; null when equal. */
export function scoreSign(score: EngineScore): 1 | -1 | 0 {
  if (score.value > 0) return 1;
  if (score.value < 0) return -1;
  return 0;
}
