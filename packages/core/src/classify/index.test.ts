import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, type Thresholds } from '../config/thresholds.js';
import type { EngineLine, EngineScore, PositionAnalysis } from '../types.js';
import { classifyMove, type MoveContext } from './index.js';
import { cpToWinProb } from './winprob.js';
import { parsePgn, type ParsedMove } from '../pgn/index.js';

const t = DEFAULT_THRESHOLDS;
const k = t.winProb.k;

/** Centipawns (any POV) that produce win probability `p` for that POV. */
const cpFor = (p: number): number => -Math.log(1 / p - 1) / k;
const cp = (value: number): EngineScore => ({ type: 'cp', value });
const mate = (value: number): EngineScore => ({ type: 'mate', value });

function pos(fen: string, lines: Array<[EngineScore, string[]]>): PositionAnalysis {
  return {
    fen,
    depth: 18,
    multipv: lines.length,
    engine: 'test',
    lines: lines.map<EngineLine>(([score, pv], i) => ({ multipv: i + 1, score, depth: 18, pv })),
  };
}

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
const AFTER_E4_C5 = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq c6 0 2';

/** FEN after playing `sans` from the start position. */
function fenFromSan(sans: string[]): string {
  const c = new Chess();
  for (const san of sans) c.move(san);
  return c.fen();
}

/** A neutral previous move (no capture, nothing lost), for tests that do not care about it. */
const QUIET_PREVIOUS: NonNullable<MoveContext['previous']> = {
  winProbLoss: 0,
  winProbBefore: 0.5,
  winProbAfter: 0.5,
  uci: 'a7a6',
  san: 'a6',
  isCapture: false,
  toSquare: 'a6',
};

/** `previous` for the miss tests: the opponent's move lost `winProbLoss`. */
function prevWithLoss(winProbLoss: number, winProbBefore = 0.6): NonNullable<MoveContext['previous']> {
  return { ...QUIET_PREVIOUS, winProbLoss, winProbBefore, winProbAfter: winProbBefore - winProbLoss };
}

function fenAfter(fen: string, uci: string): string {
  const c = new Chess(fen);
  c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined });
  return c.fen();
}

/** A plain white e2e4 from the start position; override whatever the test needs. */
function whiteCtx(overrides: Partial<MoveContext> = {}): MoveContext {
  return {
    ply: 1,
    color: 'w',
    san: 'e4',
    uci: 'e2e4',
    fenBefore: START,
    fenAfter: AFTER_E4,
    position: pos(START, [[cp(30), ['e2e4', 'e7e5']], [cp(20), ['d2d4', 'd7d5']]]),
    positionAfter: pos(AFTER_E4, [[cp(30), ['e7e5']]]),
    isBook: false,
    legalMoveCount: 20,
    ...overrides,
  };
}

/** Black's reply 1...e5 to 1.e4. */
function blackCtx(overrides: Partial<MoveContext> = {}): MoveContext {
  return {
    ply: 2,
    color: 'b',
    san: 'e5',
    uci: 'e7e5',
    fenBefore: AFTER_E4,
    fenAfter: AFTER_E4_E5,
    position: pos(AFTER_E4, [[cp(30), ['e7e5', 'g1f3']], [cp(40), ['c7c5', 'g1f3']]]),
    positionAfter: pos(AFTER_E4_E5, [[cp(30), ['g1f3']]]),
    isBook: false,
    legalMoveCount: 20,
    ...overrides,
  };
}

/**
 * White plays a non-best move (d2d4 while the engine wants e2e4) from an equal position (cp 0 = win prob 0.5)
 * that costs exactly `loss` win probability.
 */
function whiteWithLoss(loss: number, overrides: Partial<MoveContext> = {}): MoveContext {
  const after = cpFor(0.5 - loss);
  return whiteCtx({
    san: 'd4',
    uci: 'd2d4',
    fenAfter: fenAfter(START, 'd2d4'),
    position: pos(START, [[cp(0), ['e2e4', 'e7e5']], [cp(-5), ['c2c4', 'e7e5']]]),
    positionAfter: pos(fenAfter(START, 'd2d4'), [[cp(after), ['d7d5']]]),
    ...overrides,
  });
}

function withThresholds(patch: {
  brilliant?: Partial<Thresholds['brilliant']>;
  great?: Partial<Thresholds['great']>;
  miss?: Partial<Thresholds['miss']>;
}): Thresholds {
  return {
    ...t,
    brilliant: { ...t.brilliant, ...patch.brilliant },
    great: { ...t.great, ...patch.great },
    miss: { ...t.miss, ...patch.miss },
  };
}

describe('classifyMove: win probability and POV', () => {
  it('white mover: positive white-POV scores are good for the mover', () => {
    const d = classifyMove(whiteCtx({
      position: pos(START, [[cp(100), ['e2e4']]]),
      positionAfter: pos(AFTER_E4, [[cp(100), ['e7e5']]]),
    }), t);
    expect(d.winProbBefore).toBeCloseTo(cpToWinProb(100, k), 12);
    expect(d.winProbAfter).toBeCloseTo(cpToWinProb(100, k), 12);
    expect(d.winProbLoss).toBe(0);
    expect(d.cpLoss).toBe(0);
    expect(d.isBest).toBe(true);
    expect(d.classification).toBe('best');
  });

  it('black mover: negative white-POV scores are good for the mover (sign flips)', () => {
    const d = classifyMove(blackCtx({
      position: pos(AFTER_E4, [[cp(-100), ['e7e5']]]),
      positionAfter: pos(AFTER_E4_E5, [[cp(-100), ['g1f3']]]),
    }), t);
    expect(d.winProbBefore).toBeCloseTo(cpToWinProb(100, k), 12);
    expect(d.winProbAfter).toBeCloseTo(cpToWinProb(100, k), 12);
    expect(d.winProbLoss).toBe(0);
    expect(d.classification).toBe('best');
  });

  it('black mover: the eval going from -100 to +100 is a loss for black', () => {
    const d = classifyMove(blackCtx({
      uci: 'c7c5',
      san: 'c5',
      fenAfter: AFTER_E4_C5,
      position: pos(AFTER_E4, [[cp(-100), ['e7e5']]]),
      positionAfter: pos(AFTER_E4_C5, [[cp(100), ['g1f3']]]),
    }), t);
    expect(d.winProbLoss).toBeCloseTo(cpToWinProb(100, k) - cpToWinProb(-100, k), 12);
    expect(d.cpLoss).toBe(200);
    expect(d.isBest).toBe(false);
    expect(d.classification).toBe('mistake');
  });

  it('white mover: the eval going from +100 to -100 is the same loss for white', () => {
    const d = classifyMove(whiteCtx({
      uci: 'd2d4',
      san: 'd4',
      fenAfter: fenAfter(START, 'd2d4'),
      position: pos(START, [[cp(100), ['e2e4']]]),
      positionAfter: pos(fenAfter(START, 'd2d4'), [[cp(-100), ['d7d5']]]),
    }), t);
    expect(d.winProbLoss).toBeCloseTo(cpToWinProb(100, k) - cpToWinProb(-100, k), 12);
    expect(d.cpLoss).toBe(200);
  });

  it('cpLoss is clamped at 0 when the eval improves', () => {
    const d = classifyMove(whiteCtx({
      position: pos(START, [[cp(10), ['e2e4']]]),
      positionAfter: pos(AFTER_E4, [[cp(60), ['e7e5']]]),
    }), t);
    expect(d.cpLoss).toBe(0);
    expect(d.winProbLoss).toBe(0);
  });
});

describe('classifyMove: book', () => {
  it('book takes precedence over everything, even a blunder-sized loss', () => {
    const d = classifyMove(whiteWithLoss(0.4, { isBook: true }), t);
    expect(d.classification).toBe('book');
    expect(d.winProbLoss).toBeCloseTo(0.4, 9);
  });
});

describe('classifyMove: isBest', () => {
  it('is best when the played uci is the first move of the top line', () => {
    expect(classifyMove(whiteCtx(), t).isBest).toBe(true);
  });

  it('is best when a different move reaches exactly the same eval as the best line', () => {
    const d = classifyMove(whiteCtx({
      uci: 'd2d4',
      san: 'd4',
      fenAfter: fenAfter(START, 'd2d4'),
      position: pos(START, [[cp(30), ['e2e4']], [cp(29), ['d2d4']]]),
      positionAfter: pos(fenAfter(START, 'd2d4'), [[cp(30), ['d7d5']]]),
    }), t);
    expect(d.isBest).toBe(true);
    expect(d.classification).toBe('best');
  });

  it('is best when a different move reaches a better eval than the best line', () => {
    const d = classifyMove(whiteCtx({
      uci: 'd2d4',
      san: 'd4',
      fenAfter: fenAfter(START, 'd2d4'),
      position: pos(START, [[cp(30), ['e2e4']]]),
      positionAfter: pos(fenAfter(START, 'd2d4'), [[cp(45), ['d7d5']]]),
    }), t);
    expect(d.isBest).toBe(true);
    expect(d.classification).toBe('best');
  });

  it('is not best when a different move is only nearly as good', () => {
    const d = classifyMove(whiteCtx({
      uci: 'd2d4',
      san: 'd4',
      fenAfter: fenAfter(START, 'd2d4'),
      position: pos(START, [[cp(30), ['e2e4']]]),
      positionAfter: pos(fenAfter(START, 'd2d4'), [[cp(29), ['d7d5']]]),
    }), t);
    expect(d.isBest).toBe(false);
    expect(d.classification).toBe('excellent');
  });

  it('black on the same eval with a different move is best', () => {
    const d = classifyMove(blackCtx({
      uci: 'c7c5',
      san: 'c5',
      fenAfter: AFTER_E4_C5,
      position: pos(AFTER_E4, [[cp(30), ['e7e5']], [cp(31), ['c7c5']]]),
      positionAfter: pos(AFTER_E4_C5, [[cp(30), ['g1f3']]]),
    }), t);
    expect(d.isBest).toBe(true);
  });
});

describe('classifyMove: bands', () => {
  const cases: Array<[number, string]> = [
    [0.019, 'excellent'],
    [0.021, 'good'],
    [0.049, 'good'],
    [0.051, 'inaccuracy'],
    [0.099, 'inaccuracy'],
    [0.101, 'mistake'],
    [0.199, 'mistake'],
    [0.201, 'blunder'],
    [0.45, 'blunder'],
  ];
  for (const [loss, expected] of cases) {
    it(`loss ${loss} -> ${expected}`, () => {
      const d = classifyMove(whiteWithLoss(loss), t);
      expect(d.winProbLoss).toBeCloseTo(loss, 9);
      expect(d.classification).toBe(expected);
    });
  }

  it('a non-best move with (near) zero loss is excellent, not best', () => {
    const d = classifyMove(whiteWithLoss(0.0001), t);
    expect(d.isBest).toBe(false);
    expect(d.classification).toBe('excellent');
  });
});

// 1.e4 e5 2.Nf3 d6 3.Bc4 Bg4 4.Nc3 g6 5.Nxe5!! (Legal's trap: ...Bxd1?? 6.Bxf7+ Ke7 7.Nd5#)
const LEGAL_BEFORE = 'rn1qkbnr/ppp2p1p/3p2p1/4p3/2B1P1b1/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 5';
const LEGAL_AFTER = fenAfter(LEGAL_BEFORE, 'f3e5');

function legalCtx(overrides: Partial<MoveContext> = {}): MoveContext {
  return {
    ply: 9,
    color: 'w',
    san: 'Nxe5',
    uci: 'f3e5',
    fenBefore: LEGAL_BEFORE,
    fenAfter: LEGAL_AFTER,
    position: pos(LEGAL_BEFORE, [[cp(150), ['f3e5', 'd6e5', 'd1g4']], [cp(60), ['h2h3', 'g4f3']]]),
    positionAfter: pos(LEGAL_AFTER, [[cp(140), ['d6e5', 'd1g4']]]),
    isBook: false,
    legalMoveCount: 35,
    ...overrides,
  };
}

// Greek gift: 1.e4 e6 2.d4 d5 3.Nc3 Nf6 4.Bg5 Be7 5.e5 Nfd7 6.Bxe7 Qxe7 7.Nf3 O-O 8.Bd3 c5 9.Bxh7+
const GREEK_BEFORE = 'rnb2rk1/pp1nqppp/4p3/2ppP3/3P4/2NB1N2/PPP2PPP/R2QK2R w KQ - 0 9';
const GREEK_AFTER = fenAfter(GREEK_BEFORE, 'd3h7');

function greekCtx(overrides: Partial<MoveContext> = {}): MoveContext {
  return {
    ply: 17,
    color: 'w',
    san: 'Bxh7+',
    uci: 'd3h7',
    fenBefore: GREEK_BEFORE,
    fenAfter: GREEK_AFTER,
    position: pos(GREEK_BEFORE, [[cp(180), ['d3h7', 'g8h7', 'f3g5', 'h7g8', 'd1h5']], [cp(150), ['e1g1', 'c5d4']]]),
    positionAfter: pos(GREEK_AFTER, [[cp(170), ['g8h7', 'f3g5', 'h7g8', 'd1h5']]]),
    isBook: false,
    legalMoveCount: 40,
    ...overrides,
  };
}

describe('classifyMove: brilliant', () => {
  it('awards brilliant for a sound piece sacrifice (Nxe5 leaving the queen en prise)', () => {
    const d = classifyMove(legalCtx(), t);
    expect(d.isSacrifice).toBe(true);
    expect(d.classification).toBe('brilliant');
  });

  it('awards brilliant to a black mover too', () => {
    // Black Nf6-e4 is attacked by the d3 pawn and undefended (3 pawns of material), but the engine likes it.
    const before = '6k1/5ppp/5n2/8/8/3P4/5PPP/6K1 b - - 0 1';
    const after = fenAfter(before, 'f6e4');
    const d = classifyMove({
      ply: 40,
      color: 'b',
      san: 'Ne4',
      uci: 'f6e4',
      fenBefore: before,
      fenAfter: after,
      position: pos(before, [[cp(-120), ['f6e4', 'd3e4']], [cp(-10), ['g8f8']]]),
      positionAfter: pos(after, [[cp(-110), ['d3e4']]]),
      isBook: false,
      legalMoveCount: 15,
    }, t);
    expect(d.isSacrifice).toBe(true);
    expect(d.classification).toBe('brilliant');
  });

  it('Greek gift Bxh7+ nets 2 (bishop for pawn): brilliant with the default minimum of 2', () => {
    const d = classifyMove(greekCtx(), t);
    expect(d.isSacrifice).toBe(true);
    expect(d.classification).toBe('brilliant');
    // ...but not when a clean minor piece is required.
    expect(classifyMove(greekCtx(), withThresholds({ brilliant: { minSacrificeValue: 3 } })).classification).toBe('best');
  });

  it('is not brilliant when the game was already decided (winProbBefore > maxWinProbBefore)', () => {
    const d = classifyMove(legalCtx({
      position: pos(LEGAL_BEFORE, [[cp(1000), ['f3e5']], [cp(900), ['h2h3']]]),
      positionAfter: pos(LEGAL_AFTER, [[cp(990), ['d6e5']]]),
    }), t);
    expect(d.winProbBefore).toBeGreaterThan(t.brilliant.maxWinProbBefore);
    expect(d.isSacrifice).toBe(true);
    expect(d.classification).toBe('best');
  });

  it('is still brilliant from a clearly better (+5) but not decided position', () => {
    const d = classifyMove(legalCtx({
      position: pos(LEGAL_BEFORE, [[cp(500), ['f3e5']], [cp(400), ['h2h3']]]),
      positionAfter: pos(LEGAL_AFTER, [[cp(490), ['d6e5']]]),
    }), t);
    expect(d.winProbBefore).toBeLessThanOrEqual(t.brilliant.maxWinProbBefore);
    expect(d.classification).toBe('brilliant');
  });

  it('is brilliant when already decided if the sacrifice leads to forced mate (allowWhenWinningIfMate)', () => {
    const ctx = legalCtx({
      position: pos(LEGAL_BEFORE, [[cp(1000), ['f3e5']], [cp(900), ['h2h3']]]),
      positionAfter: pos(LEGAL_AFTER, [[mate(3), ['g4d1', 'c4f7', 'e8e7', 'c3d5']]]),
    });
    expect(classifyMove(ctx, t).classification).toBe('brilliant');
    expect(classifyMove(ctx, withThresholds({ brilliant: { allowWhenWinningIfMate: false } })).classification).toBe('best');
  });

  it('is not brilliant when the mate after the move is for the opponent', () => {
    const d = classifyMove(legalCtx({
      position: pos(LEGAL_BEFORE, [[cp(1000), ['h2h3']], [cp(900), ['f3e5']]]),
      positionAfter: pos(LEGAL_AFTER, [[mate(-3), ['d6e5']]]),
    }), t);
    expect(d.isSacrifice).toBe(true);
    expect(d.winProbAfter).toBeLessThan(0.001);
    expect(d.classification).toBe('blunder');
  });

  it('is not brilliant for a pawn-only sacrifice', () => {
    // e3-e4 hangs the pawn to d5xe4 and nothing defends it: sacrifice value 1.
    const before = '6k1/5ppp/8/3p4/8/4P3/5PPP/6K1 w - - 0 1';
    const after = fenAfter(before, 'e3e4');
    const d = classifyMove({
      ply: 41,
      color: 'w',
      san: 'e4',
      uci: 'e3e4',
      fenBefore: before,
      fenAfter: after,
      position: pos(before, [[cp(20), ['e3e4', 'd5e4']], [cp(0), ['g1f1']]]),
      positionAfter: pos(after, [[cp(15), ['d5e4']]]),
      isBook: false,
      legalMoveCount: 12,
    }, t);
    expect(d.isSacrifice).toBe(true);
    expect(d.classification).toBe('best');
  });

  it('is not brilliant when the sacrifice loses more than maxLossFromBest', () => {
    const d = classifyMove(legalCtx({
      position: pos(LEGAL_BEFORE, [[cp(150), ['h2h3']], [cp(50), ['f3e5']]]),
      positionAfter: pos(LEGAL_AFTER, [[cp(50), ['d6e5']]]),
    }), t);
    expect(d.isSacrifice).toBe(true);
    expect(d.classification).toBe('inaccuracy');
  });

  it('is not brilliant when the mover is losing after the move (winProbAfter below minWinProbAfter)', () => {
    const d = classifyMove(legalCtx({
      position: pos(LEGAL_BEFORE, [[cp(-100), ['f3e5']], [cp(-150), ['h2h3']]]),
      positionAfter: pos(LEGAL_AFTER, [[cp(-110), ['d6e5']]]),
    }), t);
    expect(d.isSacrifice).toBe(true);
    expect(d.classification).toBe('best');
  });

  it('is not brilliant without a sacrifice even when everything else fits', () => {
    const d = classifyMove(whiteCtx({
      position: pos(START, [[cp(100), ['e2e4']], [cp(-50), ['a2a3']]]),
      positionAfter: pos(AFTER_E4, [[cp(100), ['e7e5']]]),
    }), t);
    expect(d.isSacrifice).toBe(false);
    expect(d.classification).not.toBe('brilliant');
  });

  it('does not require the move to be the engine top move, only to be within maxLossFromBest', () => {
    const d = classifyMove(legalCtx({
      position: pos(LEGAL_BEFORE, [[cp(152), ['h2h3']], [cp(150), ['f3e5']]]),
      positionAfter: pos(LEGAL_AFTER, [[cp(150), ['d6e5']]]),
    }), t);
    expect(d.isBest).toBe(false);
    expect(d.classification).toBe('brilliant');
  });
});

describe('classifyMove: mate-in-one and terminal positions', () => {
  // Smothered mate Nd6-f7#: the knight leaves the d-file, exposing the white queen on d1 to Rd8.
  const MATE_BEFORE = '3r2rk/6pp/3N4/8/8/8/5PPP/3Q2K1 w - - 0 1';
  const MATE_AFTER = fenAfter(MATE_BEFORE, 'd6f7');

  function mateCtx(positionAfter: PositionAnalysis): MoveContext {
    return {
      ply: 61,
      color: 'w',
      san: 'Nf7#',
      uci: 'd6f7',
      fenBefore: MATE_BEFORE,
      fenAfter: MATE_AFTER,
      position: pos(MATE_BEFORE, [[mate(1), ['d6f7']], [cp(300), ['d1d5']]]),
      positionAfter,
      isBook: false,
      legalMoveCount: 30,
    };
  }

  it('a delivered mate with no engine lines after: winProbAfter 1, best, not brilliant (mate-in-one exclusion)', () => {
    const d = classifyMove(mateCtx(pos(MATE_AFTER, [])), t);
    expect(new Chess(MATE_AFTER).isCheckmate()).toBe(true);
    expect(d.winProbAfter).toBe(1);
    expect(d.winProbLoss).toBe(0);
    expect(d.cpLoss).toBe(0);
    expect(d.isBest).toBe(true);
    expect(d.isSacrifice).toBe(true);
    expect(d.classification).toBe('best');
  });

  it('a delivered mate reported as "mate 0" behaves the same', () => {
    const d = classifyMove(mateCtx(pos(MATE_AFTER, [[mate(0), []]])), t);
    expect(d.winProbAfter).toBe(1);
    expect(d.classification).toBe('best');
  });

  it('a mate-in-one sacrifice is brilliant when excludeMateInOne is off', () => {
    const d = classifyMove(mateCtx(pos(MATE_AFTER, [])), withThresholds({ brilliant: { excludeMateInOne: false } }));
    expect(d.classification).toBe('brilliant');
  });

  it('mate for the mover in the position after is not treated as mate-in-one when the game goes on', () => {
    // White queen sac Qxd1?? no — use Legal: after Nxe5 the engine sees a forced mate in 3 (not delivered yet).
    const d = classifyMove(legalCtx({
      positionAfter: pos(LEGAL_AFTER, [[mate(3), ['g4d1', 'c4f7', 'e8e7', 'c3d5']]]),
    }), t);
    expect(d.classification).toBe('brilliant');
  });

  it('stalemating from a winning position: winProbAfter 0.5, blunder', () => {
    const before = '7k/4Q3/6K1/8/8/8/8/8 w - - 0 1';
    const after = fenAfter(before, 'e7f7');
    expect(new Chess(after).isStalemate()).toBe(true);
    const d = classifyMove({
      ply: 101,
      color: 'w',
      san: 'Qf7',
      uci: 'e7f7',
      fenBefore: before,
      fenAfter: after,
      position: pos(before, [[mate(1), ['e7g7']], [mate(2), ['e7e8']]]),
      positionAfter: pos(after, []),
      isBook: false,
      legalMoveCount: 30,
    }, t);
    expect(d.winProbAfter).toBe(0.5);
    expect(d.winProbBefore).toBeGreaterThan(0.999);
    expect(d.isBest).toBe(false);
    expect(d.classification).toBe('blunder');
    // mate 1 for the mover (mateCp - 1) -> 0, clamped to the eval cap.
    expect(d.cpLoss).toBe(t.rating.evalClampCp);
  });

  it('being mated: black blunders into mate-in-one for white', () => {
    const d = classifyMove(blackCtx({
      uci: 'c7c5',
      san: 'c5',
      fenAfter: AFTER_E4_C5,
      position: pos(AFTER_E4, [[cp(30), ['e7e5']]]),
      positionAfter: pos(AFTER_E4_C5, [[mate(1), ['g1f3']]]),
    }), t);
    expect(d.winProbAfter).toBeLessThan(0.001);
    expect(d.classification).toBe('blunder');
    expect(d.cpLoss).toBe(t.rating.evalClampCp - 30); // black: -30 -> -(mateCp - 1), clamped to -evalClampCp
  });

  it('mate distance: continuing the fastest mate is best, a slower mate is not', () => {
    const onTrack = classifyMove(whiteCtx({
      uci: 'd2d4',
      san: 'd4',
      fenAfter: fenAfter(START, 'd2d4'),
      position: pos(START, [[mate(3), ['e2e4']]]),
      positionAfter: pos(fenAfter(START, 'd2d4'), [[mate(2), ['d7d5']]]),
    }), t);
    expect(onTrack.isBest).toBe(true);
    expect(onTrack.classification).toBe('best');

    const slower = classifyMove(whiteCtx({
      uci: 'd2d4',
      san: 'd4',
      fenAfter: fenAfter(START, 'd2d4'),
      position: pos(START, [[mate(3), ['e2e4']]]),
      positionAfter: pos(fenAfter(START, 'd2d4'), [[mate(5), ['d7d5']]]),
    }), t);
    expect(slower.isBest).toBe(false);
    // mate 3 -> mateCp - 3, mate 5 -> mateCp - 5: a real loss in mate distance, but both evals are
    // beyond the clamp so no centipawn loss is charged.
    expect(slower.cpLoss).toBe(0);
    expect(slower.classification).toBe('excellent');
  });

  it('mate distance for the side being mated: holding out as long as possible is best', () => {
    const held = classifyMove(blackCtx({
      position: pos(AFTER_E4, [[mate(3), ['e7e5']]]),
      positionAfter: pos(AFTER_E4_E5, [[mate(3), ['g1f3']]]),
    }), t);
    expect(held.isBest).toBe(true);
    const faster = classifyMove(blackCtx({
      uci: 'c7c5',
      san: 'c5',
      fenAfter: AFTER_E4_C5,
      position: pos(AFTER_E4, [[mate(3), ['e7e5']]]),
      positionAfter: pos(AFTER_E4_C5, [[mate(2), ['g1f3']]]),
    }), t);
    expect(faster.isBest).toBe(false);
    expect(faster.cpLoss).toBe(0);
  });

  it('falls back to the pre-move eval when positionAfter has no lines but the game is not over', () => {
    const d = classifyMove(whiteCtx({ positionAfter: pos(AFTER_E4, []) }), t);
    expect(d.winProbAfter).toBe(d.winProbBefore);
    expect(d.winProbLoss).toBe(0);
    expect(d.classification).toBe('best');
  });
});

describe('classifyMove: great', () => {
  const greatPosition = pos(START, [[cp(100), ['e2e4', 'e7e5']], [cp(-50), ['d2d4', 'd7d5']]]);

  it('awards great for the only good move with a big gap to the second line', () => {
    const d = classifyMove(whiteCtx({
      position: greatPosition,
      positionAfter: pos(AFTER_E4, [[cp(100), ['e7e5']]]),
    }), t);
    expect(cpToWinProb(100, k) - cpToWinProb(-50, k)).toBeGreaterThanOrEqual(t.great.minGapToSecondBest);
    expect(d.classification).toBe('great');
  });

  it('awards great to a black mover (gap computed in mover POV)', () => {
    const d = classifyMove(blackCtx({
      position: pos(AFTER_E4, [[cp(-100), ['e7e5']], [cp(50), ['c7c5']]]),
      positionAfter: pos(AFTER_E4_E5, [[cp(-100), ['g1f3']]]),
    }), t);
    expect(d.classification).toBe('great');
  });

  it('is not great when it is the only legal move (excludeForcedMoves)', () => {
    const ctx = whiteCtx({ position: greatPosition, positionAfter: pos(AFTER_E4, [[cp(100), ['e7e5']]]), legalMoveCount: 1 });
    expect(classifyMove(ctx, t).classification).toBe('best');
    expect(classifyMove(ctx, withThresholds({ great: { excludeForcedMoves: false } })).classification).toBe('great');
  });

  it('is not great when the mover was already winning (winProbBefore > maxWinProbBefore)', () => {
    const d = classifyMove(whiteCtx({
      position: pos(START, [[cp(700), ['e2e4']], [cp(100), ['d2d4']]]),
      positionAfter: pos(AFTER_E4, [[cp(700), ['e7e5']]]),
    }), t);
    expect(d.winProbBefore).toBeGreaterThan(t.great.maxWinProbBefore);
    expect(d.classification).toBe('best');
  });

  it('is not great when the mover was already lost (winProbBefore < minWinProbBefore)', () => {
    const d = classifyMove(whiteCtx({
      position: pos(START, [[cp(-700), ['e2e4']], [cp(-1500), ['d2d4']]]),
      positionAfter: pos(AFTER_E4, [[cp(-700), ['e7e5']]]),
    }), t);
    expect(d.winProbBefore).toBeLessThan(t.great.minWinProbBefore);
    expect(d.classification).toBe('best');
  });

  it('is not great without a second engine line', () => {
    const d = classifyMove(whiteCtx({
      position: pos(START, [[cp(100), ['e2e4']]]),
      positionAfter: pos(AFTER_E4, [[cp(100), ['e7e5']]]),
    }), t);
    expect(d.classification).toBe('best');
  });

  it('is not great when the second line is nearly as good', () => {
    const d = classifyMove(whiteCtx({
      position: pos(START, [[cp(100), ['e2e4']], [cp(80), ['d2d4']]]),
      positionAfter: pos(AFTER_E4, [[cp(100), ['e7e5']]]),
    }), t);
    expect(d.classification).toBe('best');
  });

  it('is not great when the played move is not the best move', () => {
    const d = classifyMove(whiteCtx({
      uci: 'd2d4',
      san: 'd4',
      fenAfter: fenAfter(START, 'd2d4'),
      position: greatPosition,
      positionAfter: pos(fenAfter(START, 'd2d4'), [[cp(98), ['d7d5']]]),
    }), t);
    expect(d.winProbLoss).toBeLessThan(t.great.maxLossFromBest);
    expect(d.classification).toBe('excellent');
  });

  it('brilliant wins over great when both apply', () => {
    const d = classifyMove(legalCtx({
      position: pos(LEGAL_BEFORE, [[cp(150), ['f3e5']], [cp(-50), ['h2h3']]]),
    }), t);
    expect(d.classification).toBe('brilliant');
  });
});

describe('classifyMove: miss', () => {
  const previous = prevWithLoss(0.3);

  it('awards miss when the opponent blundered 0.3 and the mover gave back 0.2', () => {
    const d = classifyMove(whiteWithLoss(0.19, { previous }), t);
    expect(d.classification).toBe('miss');
  });

  it('is not a miss when the mover gave back only 0.04 (below minOwnLoss)', () => {
    const d = classifyMove(whiteWithLoss(0.04, { previous }), t);
    expect(d.classification).toBe('good');
  });

  it('an inaccuracy is never a miss: own loss 0.071 after the opponent lost 0.103', () => {
    const d = classifyMove(whiteWithLoss(0.071, { previous: prevWithLoss(0.103) }), t);
    expect(d.classification).toBe('inaccuracy');
  });

  it('a mistake-sized give-back is a miss: own loss 0.15 after the opponent lost 0.25', () => {
    const d = classifyMove(whiteWithLoss(0.15, { previous: prevWithLoss(0.25) }), t);
    expect(d.classification).toBe('miss');
  });

  it('minOwnLoss defaults to the inaccuracy band edge (the move must be at least a mistake)', () => {
    expect(t.miss.minOwnLoss).toBe(t.bands.inaccuracy);
  });

  it('is not a miss when the give-back fraction is too small', () => {
    // 0.09 / 0.3 = 0.3 < 0.5
    const d = classifyMove(whiteWithLoss(0.09, { previous }), t);
    expect(d.classification).toBe('inaccuracy');
  });

  it('is not a miss when the opponent did not blunder enough', () => {
    const d = classifyMove(whiteWithLoss(0.07, { previous: prevWithLoss(0.08, 0.5) }), t);
    expect(d.classification).toBe('inaccuracy');
  });

  it('is not a miss without a previous move', () => {
    expect(classifyMove(whiteWithLoss(0.19), t).classification).toBe('mistake');
  });

  it('miss outranks the blunder band when the whole gain is thrown away', () => {
    const d = classifyMove(whiteWithLoss(0.3, { previous }), t);
    expect(d.classification).toBe('miss');
  });

  it('works for black movers', () => {
    const after = cpFor(1 - (0.5 - 0.19)); // white POV cp giving black 0.31
    const d = classifyMove(blackCtx({
      uci: 'c7c5',
      san: 'c5',
      fenAfter: AFTER_E4_C5,
      position: pos(AFTER_E4, [[cp(0), ['e7e5']]]),
      positionAfter: pos(AFTER_E4_C5, [[cp(after), ['g1f3']]]),
      previous,
    }), t);
    expect(d.winProbLoss).toBeCloseTo(0.19, 9);
    expect(d.classification).toBe('miss');
  });
});

// Levitsky - Marshall, Breslau 1912, after 22.Rc5: 23...Qg3!!
const MARSHALL_BEFORE = '5rk1/pp4pp/4p3/2R3Q1/3n4/2q4r/P1P2PPP/5RK1 b - - 0 23';
const MARSHALL_AFTER = fenAfter(MARSHALL_BEFORE, 'c3g3');

function marshallCtx(bestCp = -760): MoveContext {
  return {
    ply: 46,
    color: 'b',
    san: 'Qg3',
    uci: 'c3g3',
    fenBefore: MARSHALL_BEFORE,
    fenAfter: MARSHALL_AFTER,
    position: pos(MARSHALL_BEFORE, [
      [cp(bestCp), ['c3g3']],
      [cp(-708), ['c3b4']],
      [cp(-708), ['c3a3']],
    ]),
    positionAfter: pos(MARSHALL_AFTER, [
      [cp(-782), ['g5g3']],
      [mate(-7), ['g5g7']],
      [mate(-2), ['g5f4']],
    ]),
    isBook: false,
    legalMoveCount: new Chess(MARSHALL_BEFORE).moves().length,
    previous: { ...QUIET_PREVIOUS, uci: 'c1c5', san: 'Rc5', toSquare: 'c5' },
  };
}

describe('classifyMove: brilliant (win-probability gate)', () => {
  it("Marshall's 23...Qg3!! from about +7.6 for black is brilliant", () => {
    const d = classifyMove(marshallCtx(), t);
    expect(d.winProbBefore).toBeGreaterThan(0.9);
    expect(d.winProbBefore).toBeLessThanOrEqual(t.brilliant.maxWinProbBefore);
    expect(d.isSacrifice).toBe(true);
    expect(d.sacrificeValue).toBe(9);
    expect(d.classification).toBe('brilliant');
  });

  it('the same queen offer from a decided position (-15.00, winProb > 0.95) is only best', () => {
    const d = classifyMove(marshallCtx(-1500), t);
    expect(d.winProbBefore).toBeGreaterThan(t.brilliant.maxWinProbBefore);
    expect(d.classification).toBe('best');
  });

  it('Greek gift 10.Bxh7+ (Classical French, Steinitz with 7.f4) from +1.50 is brilliant', () => {
    const sans = ['e4', 'e6', 'd4', 'd5', 'Nc3', 'Nf6', 'Bg5', 'Be7', 'e5', 'Nfd7', 'Bxe7', 'Qxe7', 'f4', 'O-O', 'Nf3', 'c5', 'Bd3', 'cxd4'];
    const before = fenFromSan(sans);
    const after = fenAfter(before, 'd3h7');
    const d = classifyMove({
      ply: 19,
      color: 'w',
      san: 'Bxh7+',
      uci: 'd3h7',
      fenBefore: before,
      fenAfter: after,
      position: pos(before, [[cp(150), ['d3h7', 'g8h7', 'f3g5']], [cp(40), ['f3d4']]]),
      positionAfter: pos(after, [[cp(200), ['g8h7', 'f3g5']]]),
      isBook: false,
      legalMoveCount: new Chess(before).moves().length,
      previous: { ...QUIET_PREVIOUS, uci: 'c5d4', san: 'cxd4', isCapture: true, toSquare: 'd4' },
    }, t);
    expect(d.isSacrifice).toBe(true);
    expect(d.classification).toBe('brilliant');
  });

  it('the Evans gambit 4.b4 offers only a pawn: not brilliant', () => {
    const before = fenFromSan(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']);
    const after = fenAfter(before, 'b2b4');
    const d = classifyMove({
      ply: 7,
      color: 'w',
      san: 'b4',
      uci: 'b2b4',
      fenBefore: before,
      fenAfter: after,
      position: pos(before, [[cp(30), ['b2b4', 'c5b4']], [cp(25), ['c2c3']]]),
      positionAfter: pos(after, [[cp(30), ['c5b4']]]),
      isBook: false,
      legalMoveCount: new Chess(before).moves().length,
      previous: { ...QUIET_PREVIOUS, uci: 'f8c5', san: 'Bc5', toSquare: 'c5' },
    }, t);
    expect(d.isSacrifice).toBe(true);
    expect(d.sacrificeValue).toBe(1);
    expect(d.classification).toBe('best');
  });
});

const GAME1 = parsePgn(readFileSync(fileURLToPath(new URL('../../../../data/fixtures/game1.pgn', import.meta.url)), 'utf8'));

function game1Move(ply: number): ParsedMove {
  const m = GAME1.moves[ply - 1];
  if (!m) throw new Error(`game1 has no ply ${ply}`);
  return m;
}

/** Context for a game1 move with hand-written engine lines (white POV cp: [uci, cp] pairs). */
function game1Ctx(ply: number, lines: Array<[string, number]>): MoveContext {
  const m = game1Move(ply);
  const p = game1Move(ply - 1);
  const played = lines.find(([uci]) => uci === m.uci);
  if (!played) throw new Error('the played move must be one of the lines');
  return {
    ply,
    color: m.color,
    san: m.san,
    uci: m.uci,
    fenBefore: m.fenBefore,
    fenAfter: m.fenAfter,
    position: pos(m.fenBefore, lines.map(([uci, v]) => [cp(v), [uci]])),
    positionAfter: pos(m.fenAfter, [[cp(played[1]), []]]),
    isBook: false,
    legalMoveCount: new Chess(m.fenBefore).moves().length,
    previous: {
      winProbLoss: 0,
      winProbBefore: 0.5,
      winProbAfter: 0.5,
      uci: p.uci,
      san: p.san,
      isCapture: p.san.includes('x'),
      toSquare: p.uci.slice(2, 4),
    },
  };
}

describe('classifyMove: great excludes recaptures and free captures', () => {
  const PLY29: Array<[string, number]> = [['d1d2', 341], ['c1d2', -145]];
  const PLY50: Array<[string, number]> = [['d7f5', -514], ['g6f5', 527]];
  const PLY69: Array<[string, number]> = [['d2e2', 428], ['d1b1', -593]];

  it('the fixture plies are what the tests claim', () => {
    expect([game1Move(28).san, game1Move(29).san, game1Move(50).san, game1Move(69).san]).toEqual(['Qxd2+', 'Rxd2', 'Bxf5', 'Kxe2']);
  });

  it('game1 ply 29 Rxd2 (recapturing the queen after 14...Qxd2+) is not great', () => {
    const ctx = game1Ctx(29, PLY29);
    expect(classifyMove(ctx, t).classification).toBe('best');
    // Both exclusions apply: the queen was also simply hanging.
    expect(classifyMove(ctx, withThresholds({ great: { excludeRecaptures: false } })).classification).toBe('best');
    expect(classifyMove(ctx, withThresholds({ great: { excludeFreeCaptures: false } })).classification).toBe('best');
    expect(classifyMove(ctx, withThresholds({ great: { excludeRecaptures: false, excludeFreeCaptures: false } })).classification).toBe('great');
  });

  it('game1 ply 50 Bxf5 (taking an undefended knight) is not great', () => {
    const ctx = game1Ctx(50, PLY50);
    expect(classifyMove(ctx, t).classification).toBe('best');
    expect(classifyMove(ctx, withThresholds({ great: { excludeFreeCaptures: false } })).classification).toBe('great');
  });

  it('game1 ply 50 Bxf5 is not brilliant either: a free capture offers nothing', () => {
    const d = classifyMove(game1Ctx(50, PLY50), t);
    expect(d.isSacrifice).toBe(false);
    expect(d.classification).not.toBe('brilliant');
  });

  it('game1 ply 69 Kxe2 (taking a hanging bishop) is not great', () => {
    const ctx = game1Ctx(69, PLY69);
    expect(classifyMove(ctx, t).classification).toBe('best');
    expect(classifyMove(ctx, withThresholds({ great: { excludeFreeCaptures: false } })).classification).toBe('great');
  });

  it('a recapture is only excluded on the square the opponent just captured on', () => {
    // Ply 69 Kxe2 with a made-up previous capture on another square: still a free capture, so
    // only the recapture flag is under test here.
    const ctx = { ...game1Ctx(69, PLY69), previous: { ...QUIET_PREVIOUS, isCapture: true, toSquare: 'd6' } };
    expect(classifyMove(ctx, withThresholds({ great: { excludeFreeCaptures: false } })).classification).toBe('great');
    const onSquare = { ...ctx, previous: { ...ctx.previous, toSquare: 'e2' } };
    expect(classifyMove(onSquare, withThresholds({ great: { excludeFreeCaptures: false } })).classification).toBe('best');
  });

  it('a genuine only-move that is not a capture is still great (Kh2, the only move that avoids mate)', () => {
    // Back-rank check: Kh2 holds, the bishop blocks Bf1 / Bd1 lose to a mating attack.
    const before = '6k1/5ppp/8/8/8/8/4BPP1/r5K1 w - - 0 1';
    const after = fenAfter(before, 'g1h2');
    const d = classifyMove({
      ply: 61,
      color: 'w',
      san: 'Kh2',
      uci: 'g1h2',
      fenBefore: before,
      fenAfter: after,
      position: pos(before, [[cp(0), ['g1h2']], [mate(-2), ['e2f1']], [mate(-2), ['e2d1']]]),
      positionAfter: pos(after, [[cp(0), ['a1a2']]]),
      isBook: false,
      legalMoveCount: new Chess(before).moves().length,
      previous: { ...QUIET_PREVIOUS, uci: 'a8a1', san: 'Ra1+', toSquare: 'a1' },
    }, t);
    expect(new Chess(before).moves().length).toBe(3);
    expect(d.classification).toBe('great');
  });
});

