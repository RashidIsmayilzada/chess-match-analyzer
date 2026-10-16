import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '../config/thresholds.js';
import { cpToWinProb, isMateZero, positionScoreToCp, scoreFromMoverPov, scoreFromPov, scoreToCp, scoreToWinProb } from './winprob.js';

const t = DEFAULT_THRESHOLDS;
const k = t.winProb.k;
const mateCp = t.winProb.mateCp;

describe('cpToWinProb', () => {
  it('is 0.5 at zero centipawns', () => {
    expect(cpToWinProb(0, k)).toBeCloseTo(0.5, 12);
  });

  it('is symmetric around 0.5', () => {
    expect(cpToWinProb(150, k) + cpToWinProb(-150, k)).toBeCloseTo(1, 12);
  });

  it('matches the Lichess sigmoid', () => {
    // 1 / (1 + exp(-k * cp))
    expect(cpToWinProb(100, k)).toBeCloseTo(1 / (1 + Math.exp(-k * 100)), 12);
    expect(cpToWinProb(100, k)).toBeGreaterThan(0.59);
    expect(cpToWinProb(100, k)).toBeLessThan(0.6);
  });

  it('is monotonic and clamped to 0..1', () => {
    expect(cpToWinProb(300, k)).toBeGreaterThan(cpToWinProb(200, k));
    expect(cpToWinProb(1e9, k)).toBe(1);
    expect(cpToWinProb(-1e9, k)).toBe(0);
    expect(cpToWinProb(Number.POSITIVE_INFINITY, k)).toBe(1);
    expect(cpToWinProb(Number.NEGATIVE_INFINITY, k)).toBe(0);
  });
});

describe('scoreFromPov', () => {
  it('keeps a white-POV score for white', () => {
    expect(scoreFromPov({ type: 'cp', value: 120 }, 'w')).toEqual({ type: 'cp', value: 120 });
    expect(scoreFromPov({ type: 'mate', value: -4 }, 'w')).toEqual({ type: 'mate', value: -4 });
  });

  it('negates cp and mate for black', () => {
    expect(scoreFromPov({ type: 'cp', value: 120 }, 'b')).toEqual({ type: 'cp', value: -120 });
    expect(scoreFromPov({ type: 'mate', value: -4 }, 'b')).toEqual({ type: 'mate', value: 4 });
  });

  it('does not produce negative zero', () => {
    expect(Object.is(scoreFromPov({ type: 'cp', value: 0 }, 'b').value, 0)).toBe(true);
  });

  it('scoreFromMoverPov is an alias', () => {
    expect(scoreFromMoverPov).toBe(scoreFromPov);
  });
});

describe('scoreToCp', () => {
  it('passes cp through', () => {
    expect(scoreToCp({ type: 'cp', value: -37 }, mateCp)).toBe(-37);
  });

  it('maps mate scores to +-mateCp minus distance so closer mates are bigger', () => {
    expect(scoreToCp({ type: 'mate', value: 3 }, mateCp)).toBe(mateCp - 3);
    expect(scoreToCp({ type: 'mate', value: 1 }, mateCp)).toBe(mateCp - 1);
    expect(scoreToCp({ type: 'mate', value: 1 }, mateCp)).toBeGreaterThan(scoreToCp({ type: 'mate', value: 3 }, mateCp));
    expect(scoreToCp({ type: 'mate', value: -3 }, mateCp)).toBe(-(mateCp - 3));
    expect(scoreToCp({ type: 'mate', value: -1 }, mateCp)).toBeLessThan(scoreToCp({ type: 'mate', value: -3 }, mateCp));
  });

  it('keeps every mate above every cp score', () => {
    expect(scoreToCp({ type: 'mate', value: 99 }, mateCp)).toBeGreaterThan(scoreToCp({ type: 'cp', value: 5000 }, mateCp));
  });

  it('refuses "mate 0": a zero has no sign, so the winner is unknown without the side to move', () => {
    expect(() => scoreToCp({ type: 'mate', value: 0 }, mateCp)).toThrow(RangeError);
    expect(() => scoreToCp({ type: 'mate', value: -0 }, mateCp)).toThrow(RangeError);
  });
});

describe('positionScoreToCp', () => {
  it('resolves mate 0 with the side to move: the side to move is the mated side', () => {
    expect(positionScoreToCp({ type: 'mate', value: 0 }, 'w', mateCp)).toBe(-mateCp);
    expect(positionScoreToCp({ type: 'mate', value: 0 }, 'b', mateCp)).toBe(mateCp);
  });

  it('otherwise behaves like scoreToCp', () => {
    expect(positionScoreToCp({ type: 'cp', value: -37 }, 'w', mateCp)).toBe(-37);
    expect(positionScoreToCp({ type: 'mate', value: -2 }, 'b', mateCp)).toBe(-(mateCp - 2));
  });

  it('isMateZero only matches mate 0', () => {
    expect(isMateZero({ type: 'mate', value: 0 })).toBe(true);
    expect(isMateZero({ type: 'mate', value: 1 })).toBe(false);
    expect(isMateZero({ type: 'cp', value: 0 })).toBe(false);
  });
});

describe('scoreToWinProb', () => {
  it('is mover POV: the same white-POV score flips for black', () => {
    const score = { type: 'cp' as const, value: 200 };
    const w = scoreToWinProb(score, 'w', t);
    const b = scoreToWinProb(score, 'b', t);
    expect(w).toBeGreaterThan(0.5);
    expect(b).toBeLessThan(0.5);
    expect(w + b).toBeCloseTo(1, 12);
  });

  it('converts mate scores to ~1 / ~0 for the right colour', () => {
    expect(scoreToWinProb({ type: 'mate', value: 2 }, 'w', t)).toBeGreaterThan(0.999);
    expect(scoreToWinProb({ type: 'mate', value: 2 }, 'b', t)).toBeLessThan(0.001);
    expect(scoreToWinProb({ type: 'mate', value: -2 }, 'b', t)).toBeGreaterThan(0.999);
    expect(scoreToWinProb({ type: 'mate', value: -2 }, 'w', t)).toBeLessThan(0.001);
  });

  it('mate 0: the side to move is mated, the other side has won', () => {
    const mated = { type: 'mate' as const, value: 0 };
    // White delivered mate: black is to move and is checkmated.
    expect(scoreToWinProb(mated, 'w', t, 'b')).toBeGreaterThan(0.999);
    expect(scoreToWinProb(mated, 'b', t, 'b')).toBeLessThan(0.001);
    // Black delivered mate: white is to move and is checkmated.
    expect(scoreToWinProb(mated, 'w', t, 'w')).toBeLessThan(0.001);
    expect(scoreToWinProb(mated, 'b', t, 'w')).toBeGreaterThan(0.999);
    // JSON round-trips lose the sign of -0, so it must not carry meaning.
    expect(scoreToWinProb({ type: 'mate', value: -0 }, 'b', t, 'b')).toBeLessThan(0.001);
  });

  it('mate 0 without the side to move throws instead of guessing', () => {
    expect(() => scoreToWinProb({ type: 'mate', value: 0 }, 'b', t)).toThrow(RangeError);
  });

  it('equals cpToWinProb(scoreToCp(scoreFromPov(...)))', () => {
    const score = { type: 'mate' as const, value: -5 };
    expect(scoreToWinProb(score, 'b', t)).toBe(cpToWinProb(scoreToCp(scoreFromPov(score, 'b'), mateCp), k));
  });
});
