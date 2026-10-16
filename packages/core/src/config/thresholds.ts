/**
 * All tunable numbers used by the classifier live here.
 *
 * Win probabilities are 0..1 from the MOVER's point of view.
 * "Loss" values are differences of win probabilities (e.g. 0.05 = five percentage points).
 */

export interface Thresholds {
  winProb: {
    /** Sigmoid steepness. Lichess uses 0.00368208 for cp -> win%. */
    k: number;
    /** Centipawn magnitude used when converting mate scores to a win probability basis. */
    mateCp: number;
  };

  /**
   * Classification bands by win-probability loss (mover POV), checked in order.
   * A move with loss <= best counts as "best" only if it is the engine's top move
   * (or has an identical eval to it); otherwise it falls through to excellent.
   */
  bands: {
    excellent: number;
    good: number;
    inaccuracy: number;
    mistake: number;
    /** Anything above `mistake` is a blunder. */
  };

  brilliant: {
    /** Move must be within this win-prob loss of the best move. */
    maxLossFromBest: number;
    /**
     * Minimum NET material given up (pawn units: SEE loss minus what the move itself captures)
     * for a move to count as a sacrifice. 2 = an exchange sacrifice or a piece for a pawn
     * (Greek gift Bxh7+ Kxh7 nets 3 - 1 = 2); 3 = a clean minor piece.
     */
    minSacrificeValue: number;
    /** No brilliant when the mover was already winning by more than this (cp, mover POV)... */
    maxEvalBeforeCp: number;
    /** ...unless the move leads to forced mate for the mover (allowed when true). */
    allowWhenWinningIfMate: boolean;
    /** Mover must retain at least this win probability after the move (not losing). */
    minWinProbAfter: number;
    /** Do not award brilliant if the move is a mate-in-one. */
    excludeMateInOne: boolean;
  };

  great: {
    /** Move must be within this win-prob loss of the best move. */
    maxLossFromBest: number;
    /** The second-best engine line must be at least this much worse (win prob) than the best. */
    minGapToSecondBest: number;
    /** Not awarded when the mover was already winning with more than this probability before the move. */
    maxWinProbBefore: number;
    /** Not awarded when the mover is already lost (below this win prob before the move). */
    minWinProbBefore: number;
    /** Not awarded for the only legal move. */
    excludeForcedMoves: boolean;
  };

  miss: {
    /** The opponent's previous move must have lost at least this much win prob (i.e. was a mistake or worse). */
    minOpponentLoss: number;
    /** The mover must have given back at least this fraction of the gained win probability. */
    minGiveBackFraction: number;
    /** The mover's own loss must be at least this much (otherwise it is just a good/excellent move). */
    minOwnLoss: number;
  };

  accuracy: {
    /** accuracy% per move = a * exp(b * winProbLossPct) + c  (Lichess constants). */
    a: number;
    b: number;
    c: number;
  };

  rating: {
    /**
     * Estimated rating = base - slope * averageCpLoss, clamped to [min, max], per time class.
     * Deliberately simple; tune against real games.
     */
    byTimeClass: Record<'bullet' | 'blitz' | 'rapid', { base: number; slope: number }>;
    min: number;
    max: number;
    /**
     * Evals (cp, mover POV, mate converted via winProb.mateCp) are clamped to +-evalClampCp before
     * the per-move centipawn loss is computed, so swings between "mate in 9" and "+12" in a trivially
     * won position do not inflate averageCpLoss. Lichess uses 1000.
     */
    evalClampCp: number;
  };

  keyMoments: {
    /** Win-prob swing that makes a move a key moment regardless of classification. */
    minSwing: number;
    /** Max key moments to return. */
    max: number;
  };
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  winProb: {
    k: 0.00368208,
    mateCp: 10000,
  },
  bands: {
    excellent: 0.02,
    good: 0.05,
    inaccuracy: 0.1,
    mistake: 0.2,
  },
  brilliant: {
    maxLossFromBest: 0.02,
    minSacrificeValue: 2,
    maxEvalBeforeCp: 300,
    allowWhenWinningIfMate: true,
    minWinProbAfter: 0.45,
    excludeMateInOne: true,
  },
  great: {
    maxLossFromBest: 0.02,
    minGapToSecondBest: 0.1,
    maxWinProbBefore: 0.9,
    minWinProbBefore: 0.1,
    excludeForcedMoves: true,
  },
  miss: {
    minOpponentLoss: 0.1,
    minGiveBackFraction: 0.5,
    minOwnLoss: 0.05,
  },
  accuracy: {
    a: 103.1668,
    b: -0.04354,
    c: -3.1669,
  },
  rating: {
    byTimeClass: {
      bullet: { base: 2400, slope: 22 },
      blitz: { base: 2500, slope: 22 },
      rapid: { base: 2600, slope: 22 },
    },
    min: 100,
    max: 3200,
    evalClampCp: 1000,
  },
  keyMoments: {
    minSwing: 0.15,
    max: 8,
  },
};

/** Material values in pawn units used for sacrifice detection. */
export const PIECE_VALUES: Record<'p' | 'n' | 'b' | 'r' | 'q' | 'k', number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};
