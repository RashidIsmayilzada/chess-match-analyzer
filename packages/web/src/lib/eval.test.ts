import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '@chess-analyzer/core/thresholds';
import { formatBarLabel, formatScore, GRAPH_CLAMP, isDeliveredMate, mateWinner, scoreSign, scoreToPawns, whiteBarPercent } from './eval';

const MATE_CP = DEFAULT_THRESHOLDS.winProb.mateCp;
const mated = { type: 'mate' as const, value: 0 };

describe('delivered mate ("mate 0": the side to move is checkmated)', () => {
  it('is recognised for mate 0 and for legacy cp +-mateCp, not for ordinary scores', () => {
    expect(isDeliveredMate(mated)).toBe(true);
    expect(isDeliveredMate({ type: 'cp', value: MATE_CP })).toBe(true);
    expect(isDeliveredMate({ type: 'cp', value: -MATE_CP })).toBe(true);
    expect(isDeliveredMate({ type: 'cp', value: 9080 })).toBe(false);
    expect(isDeliveredMate({ type: 'mate', value: 1 })).toBe(false);
  });

  it('names the winner from the side to move', () => {
    expect(mateWinner(mated, 'b')).toBe('w');
    expect(mateWinner(mated, 'w')).toBe('b');
    expect(mateWinner(mated)).toBeUndefined();
    expect(mateWinner({ type: 'mate', value: -3 })).toBe('b');
    expect(mateWinner({ type: 'cp', value: MATE_CP })).toBe('w');
  });

  it('formats as the game result next to the board and "#" on the bar', () => {
    expect(formatScore(mated, 'b')).toBe('1-0');
    expect(formatScore(mated, 'w')).toBe('0-1');
    expect(formatScore(mated)).toBe('#');
    expect(formatScore({ type: 'cp', value: MATE_CP })).toBe('1-0');
    expect(formatScore({ type: 'cp', value: -MATE_CP })).toBe('0-1');
    expect(formatBarLabel(mated)).toBe('#');
    expect(formatBarLabel({ type: 'cp', value: MATE_CP })).toBe('#');
  });

  it('fills the bar and clamps the graph for the winner', () => {
    expect(whiteBarPercent(mated, 'b')).toBe(100);
    expect(whiteBarPercent(mated, 'w')).toBe(0);
    expect(whiteBarPercent({ type: 'cp', value: MATE_CP })).toBe(100);
    expect(whiteBarPercent({ type: 'cp', value: -MATE_CP })).toBe(0);
    expect(scoreToPawns(mated, 'b')).toBe(GRAPH_CLAMP);
    expect(scoreToPawns(mated, 'w')).toBe(-GRAPH_CLAMP);
    expect(scoreToPawns({ type: 'cp', value: -MATE_CP })).toBe(-GRAPH_CLAMP);
    expect(scoreSign(mated, 'b')).toBe(1);
    expect(scoreSign(mated, 'w')).toBe(-1);
  });
});

describe('ordinary scores', () => {
  it('formats cp and mate-in-n', () => {
    expect(formatScore({ type: 'cp', value: 130 })).toBe('+1.3');
    expect(formatScore({ type: 'cp', value: -40 })).toBe('-0.4');
    expect(formatScore({ type: 'cp', value: 0 })).toBe('0.0');
    expect(formatScore({ type: 'mate', value: 5 })).toBe('M5');
    expect(formatScore({ type: 'mate', value: -3 })).toBe('-M3');
    expect(formatBarLabel({ type: 'mate', value: -3 })).toBe('M3');
    expect(formatBarLabel({ type: 'cp', value: -40 })).toBe('0.4');
  });

  it('bar percentage is 50 at equality, clamped to 3..97 for cp, 100/0 for forced mates', () => {
    expect(whiteBarPercent({ type: 'cp', value: 0 })).toBeCloseTo(50, 6);
    expect(whiteBarPercent({ type: 'cp', value: 5000 })).toBe(97);
    expect(whiteBarPercent({ type: 'cp', value: -5000 })).toBe(3);
    expect(whiteBarPercent({ type: 'mate', value: 2 })).toBe(100);
    expect(whiteBarPercent({ type: 'mate', value: -2 })).toBe(0);
  });

  it('graph values are pawns clamped to +-GRAPH_CLAMP', () => {
    expect(scoreToPawns({ type: 'cp', value: 250 })).toBe(2.5);
    expect(scoreToPawns({ type: 'cp', value: -2500 })).toBe(-GRAPH_CLAMP);
    expect(scoreToPawns({ type: 'mate', value: 4 })).toBe(GRAPH_CLAMP);
  });
});
