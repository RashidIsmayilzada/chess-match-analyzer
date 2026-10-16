import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '../config/thresholds.js';
import { cpToWinProb, scoreFromMoverPov, scoreFromPov, scoreToCp, scoreToWinProb } from './winprob.js';

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

  it('treats mate 0 as a delivered mate (side to move is checkmated) in white POV', () => {
    // "mate 0" is sign-ambiguous: +0 = the side to move (black, if white just mated) is mated.
    expect(scoreToCp({ type: 'mate', value: 0 }, mateCp)).toBe(mateCp);
    expect(scoreToCp({ type: 'mate', value: -0 }, mateCp)).toBe(-mateCp);
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

  it('equals cpToWinProb(scoreToCp(scoreFromPov(...)))', () => {
    const score = { type: 'mate' as const, value: -5 };
    expect(scoreToWinProb(score, 'b', t)).toBe(cpToWinProb(scoreToCp(scoreFromPov(score, 'b'), mateCp), k));
  });
});
