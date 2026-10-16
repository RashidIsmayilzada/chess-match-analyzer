import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../config/thresholds.js';
import { estimateRating, gameAccuracy, moveAccuracy, type AccuracyInput } from './accuracy.js';

const t = DEFAULT_THRESHOLDS;
const { a, b, c } = t.accuracy;

describe('moveAccuracy', () => {
  it('is ~100 for no loss and clamped to 100', () => {
    expect(moveAccuracy(0, t)).toBeLessThanOrEqual(100);
    expect(moveAccuracy(0, t)).toBeGreaterThan(99.9);
  });

  it('uses a * exp(b * loss%) + c', () => {
    const loss = 0.1; // 10 percentage points
    expect(moveAccuracy(loss, t)).toBeCloseTo(a * Math.exp(b * 10) + c, 9);
  });

  it('decreases with loss and clamps at 0', () => {
    expect(moveAccuracy(0.05, t)).toBeGreaterThan(moveAccuracy(0.2, t));
    expect(moveAccuracy(1, t)).toBe(0);
  });

  it('treats a negative loss as zero loss', () => {
    expect(moveAccuracy(-0.3, t)).toBe(moveAccuracy(0, t));
  });

  it('returns 0 for NaN input rather than propagating NaN', () => {
    expect(moveAccuracy(Number.NaN, t)).toBe(0);
  });
});

describe('gameAccuracy', () => {
  const moves: AccuracyInput[] = [
    { color: 'w', winProbLoss: 0, classification: 'book' },
    { color: 'b', winProbLoss: 0, classification: 'book' },
    { color: 'w', winProbLoss: 0.1, classification: 'inaccuracy' },
    { color: 'b', winProbLoss: 0.3, classification: 'blunder' },
    { color: 'w', winProbLoss: 0.5, classification: 'book' }, // book counts as 100 regardless of loss
  ];

  it('returns 100 for an empty game / colour with no moves', () => {
    expect(gameAccuracy([], 'w', t)).toBe(100);
    expect(gameAccuracy([{ color: 'b', winProbLoss: 0.4, classification: 'blunder' }], 'w', t)).toBe(100);
  });

  it('averages per-move accuracies of the given colour, book moves = 100', () => {
    const expectedWhite = (100 + moveAccuracy(0.1, t) + 100) / 3;
    const expectedBlack = (100 + moveAccuracy(0.3, t)) / 2;
    expect(gameAccuracy(moves, 'w', t)).toBeCloseTo(expectedWhite, 9);
    expect(gameAccuracy(moves, 'b', t)).toBeCloseTo(expectedBlack, 9);
  });

  it('stays within 0..100', () => {
    const terrible: AccuracyInput[] = Array.from({ length: 10 }, () => ({ color: 'w', winProbLoss: 1, classification: 'blunder' }));
    expect(gameAccuracy(terrible, 'w', t)).toBe(0);
  });
});

describe('estimateRating', () => {
  it('is base - slope * averageCpLoss per time class', () => {
    expect(estimateRating(20, 'blitz', t)).toBe(2500 - 22 * 20);
    expect(estimateRating(20, 'bullet', t)).toBe(2400 - 22 * 20);
    expect(estimateRating(20, 'rapid', t)).toBe(2600 - 22 * 20);
  });

  it('clamps to [min, max]', () => {
    expect(estimateRating(0, 'rapid', t)).toBe(2600); // below max
    expect(estimateRating(10_000, 'bullet', t)).toBe(t.rating.min);
    const generous: Thresholds = { ...t, rating: { ...t.rating, byTimeClass: { ...t.rating.byTimeClass, rapid: { base: 5000, slope: 1 } } } };
    expect(estimateRating(0, 'rapid', generous)).toBe(t.rating.max);
  });

  it('rounds to a whole number', () => {
    expect(Number.isInteger(estimateRating(12.345, 'blitz', t))).toBe(true);
  });
});
