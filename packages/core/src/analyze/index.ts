/**
 * Game analysis orchestration. See docs/ARCHITECTURE.md (module "analyze").
 */
import type { AnalysisSettings, GameAnalysis, PositionAnalysis, TimeClass } from '../types.js';
import type { Thresholds } from '../config/thresholds.js';
import type { UciEngine } from '../engine/index.js';
import type { OpeningBook } from '../openings/index.js';

/** Memoisation of engine results, e.g. backed by SQLite in the server. */
export interface PositionCache {
  get(fen: string, depth: number, multiPv: number, engine: string): Promise<PositionAnalysis | undefined>;
  set(analysis: PositionAnalysis): Promise<void>;
}

export interface AnalyzeGameOptions {
  gameId: string;
  pgn: string;
  timeClass: TimeClass;
  whiteUsername: string;
  blackUsername: string;
  whiteRating?: number;
  blackRating?: number;
  engine: UciEngine;
  book: OpeningBook;
  settings: AnalysisSettings;
  thresholds: Thresholds;
  cache?: PositionCache;
  /** progress 0..1, called after every analysed position. */
  onProgress?: (progress: number) => void;
  /** Abort signal; when aborted the engine is stopped and the promise rejects. */
  signal?: AbortSignal;
}

/** Deterministic key for an AnalysisSettings (depth, multiPv, movetime, engine name). */
export function settingsKey(_settings: AnalysisSettings, _engineName: string): string {
  throw new Error('not implemented');
}

export async function analyzeGame(_opts: AnalyzeGameOptions): Promise<GameAnalysis> {
  throw new Error('not implemented');
}
