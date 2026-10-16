/**
 * Shared domain types for chess-analyzer.
 *
 * CONVENTIONS
 * - All engine scores are normalised to WHITE's point of view ("white POV").
 * - Win probability is always expressed from the MOVER's point of view, 0..1.
 * - Moves are given both as UCI ("e2e4", "e7e8q") and SAN ("e4", "e8=Q+").
 * - Ply is 1-based: ply 1 = White's first move, ply 2 = Black's first move.
 */

export type Color = 'w' | 'b';

export type TimeClass = 'bullet' | 'blitz' | 'rapid';

export type Classification =
  | 'brilliant'
  | 'great'
  | 'best'
  | 'excellent'
  | 'good'
  | 'book'
  | 'inaccuracy'
  | 'mistake'
  | 'miss'
  | 'blunder';

export const ALL_CLASSIFICATIONS: readonly Classification[] = [
  'brilliant',
  'great',
  'best',
  'excellent',
  'good',
  'book',
  'inaccuracy',
  'mistake',
  'miss',
  'blunder',
];

/**
 * Engine score. `cp` is centipawns, `mate` is moves-to-mate (negative = getting mated). White POV.
 *
 * `mate 0` means the side to move has been checkmated. A zero carries no sign, so the winner is
 * not part of the score: it is whoever is NOT to move in that position (derive it from the FEN;
 * core's `positionScoreToCp` / `scoreToWinProb(..., sideToMove)` take it). `MoveAnalysis.evalAfter`
 * is `mate 0` after a mating move. A cp score is never used to stand in for a mate.
 */
export interface EngineScore {
  type: 'cp' | 'mate';
  value: number;
}

export interface EngineLine {
  /** 1-based MultiPV rank; 1 = best line. */
  multipv: number;
  score: EngineScore;
  depth: number;
  /** Principal variation as UCI moves, first move is the line's move. */
  pv: string[];
}

/** Engine output for one position. Scores are white POV regardless of side to move. */
export interface PositionAnalysis {
  fen: string;
  /**
   * Search depth. The engine reports the deepest depth it actually reached; `analyzeGame`
   * normalises this to the REQUESTED depth before caching so cache keys match the settings.
   * Individual lines keep the depth they were reported at.
   */
  depth: number;
  multipv: number;
  lines: EngineLine[];
  /** Engine identification, e.g. "Stockfish 19". */
  engine: string;
}

export interface AnalysisSettings {
  /** Fixed search depth. Ignored when `movetimeMs` is set. */
  depth: number;
  /** Number of principal variations. Minimum 2 is required for Great / Brilliant detection. */
  multiPv: number;
  threads: number;
  hashMb: number;
  /** Optional time-per-move override, in milliseconds. When set, `depth` is ignored. */
  movetimeMs?: number;
  /** Absolute or project-relative path to the UCI engine binary. */
  enginePath: string;
}

export interface MoveRef {
  uci: string;
  san: string;
}

export interface OpeningRef {
  eco: string;
  name: string;
}

export interface MoveAnalysis {
  ply: number;
  color: Color;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;

  /** Engine eval of the position BEFORE the move (white POV). */
  evalBefore: EngineScore;
  /** Engine eval of the position AFTER the move (white POV). */
  evalAfter: EngineScore;

  /** Win probability for the MOVER before / after the move, 0..1. */
  winProbBefore: number;
  winProbAfter: number;
  /** winProbBefore - winProbAfter, clamped at 0. */
  winProbLoss: number;
  /**
   * Centipawn loss for the mover, clamped at 0. Mate scores are converted with a large constant
   * and both evals are clamped to +-thresholds.rating.evalClampCp before subtracting.
   */
  cpLoss: number;

  /** Engine's best move in the position before the move. */
  bestMove: MoveRef;
  /** Best line (SAN) from the position before the move. */
  bestLine: string[];
  /** Engine's second best line from the position before the move, when MultiPV >= 2. */
  secondBest?: { move: MoveRef; score: EngineScore };

  /** Full engine output for the position before the move. */
  position: PositionAnalysis;

  classification: Classification;
  /** Present on book moves. */
  opening?: OpeningRef;

  /** True when this move was flagged as a material sacrifice by the classifier. */
  isSacrifice?: boolean;
  /**
   * Present with `isSacrifice`: the gross material (pawn units) the move offers, e.g. 9 for a
   * queen sacrifice (the classifier's threshold uses the NET value, see detectSacrifice).
   */
  sacrificeValue?: number;
  /** Clock after the move, in seconds, if present in the PGN. */
  clockSeconds?: number;
}

export interface PlayerSummary {
  username: string;
  rating?: number;
  /** 0..100 */
  accuracy: number;
  /** Rough estimate of playing strength for this game. */
  estimatedRating: number;
  averageCpLoss: number;
  counts: Record<Classification, number>;
}

export interface GameAnalysis {
  gameId: string;
  settings: AnalysisSettings;
  /** Hash of settings used so cached analyses can be matched. */
  settingsKey: string;
  moves: MoveAnalysis[];
  white: PlayerSummary;
  black: PlayerSummary;
  opening: OpeningRef & {
    /** Ply of the last book move (0 if none). */
    lastBookPly: number;
  };
  /** Plies that are "key moments": blunders, misses, brilliants, big swings. */
  keyMoments: number[];
  /** ISO timestamp when the analysis was produced. */
  analyzedAt: string;
}

export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*';

/** A game as stored in the database, imported from chess.com. */
export interface GameRecord {
  /** chess.com game uuid. */
  id: string;
  url: string;
  /**
   * The profile this game is viewed for (lowercase): the `profile` filter/query it was requested
   * with when the game is linked to that profile, otherwise the profile that first imported it.
   * A game between two imported profiles is linked to both.
   */
  profileUsername: string;
  timeClass: TimeClass;
  /** chess.com time_control string, e.g. "300", "180+2". */
  timeControl: string;
  rated: boolean;
  /** Unix seconds. */
  endTime: number;
  white: { username: string; rating: number; result: string };
  black: { username: string; rating: number; result: string };
  result: GameResult;
  pgn: string;
  /** chess.com ECO code and opening name parsed from PGN headers, if present. */
  eco?: string;
  openingName?: string;
  /** True when a GameAnalysis exists for the current settings. */
  analyzed: boolean;
  /** Per-player accuracy (0..100) of the analysis behind `analyzed`, when one exists. */
  accuracy?: { white: number; black: number };
}

export interface Profile {
  username: string;
  /** Unix seconds of the last completed full ("all") sync. A "latest N" import does not set it. */
  lastSync?: number;
  gameCount: number;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface AnalysisJob {
  id: string;
  gameId: string;
  status: JobStatus;
  /** 0..1 progress for running jobs. */
  progress: number;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ImportJob {
  id: string;
  username: string;
  mode: 'all' | 'latest';
  count?: number;
  status: JobStatus;
  /** Months processed / total months, for "all" mode. */
  progress: number;
  imported: number;
  skipped: number;
  error?: string;
}
