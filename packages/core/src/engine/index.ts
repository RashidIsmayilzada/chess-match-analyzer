/**
 * UCI engine wrapper. See docs/ARCHITECTURE.md (module "engine").
 * Scores returned are normalised to WHITE POV.
 */
import type { AnalysisSettings, PositionAnalysis } from '../types.js';

export interface UciEngineOptions {
  enginePath: string;
  threads?: number;
  hashMb?: number;
  /** Called with raw engine stdout lines, for debugging. */
  onLine?: (line: string) => void;
}

export type SearchSettings = Pick<AnalysisSettings, 'depth' | 'multiPv' | 'movetimeMs'>;

export class UciEngine {
  constructor(_opts: UciEngineOptions) {
    throw new Error('not implemented');
  }
  /** Spawn the process, run `uci`, apply options, wait for `readyok`. Resolves with the engine name. */
  async start(): Promise<string> {
    throw new Error('not implemented');
  }
  /** Analyse a position. Calls are serialised: a second call waits for the first to finish. */
  async analyse(_fen: string, _settings: SearchSettings): Promise<PositionAnalysis> {
    throw new Error('not implemented');
  }
  /** Interrupt the current search (the pending analyse() resolves with the best result so far). */
  stop(): void {
    throw new Error('not implemented');
  }
  /** Change Threads / Hash at runtime (between searches). */
  async setOptions(_opts: { threads?: number; hashMb?: number }): Promise<void> {
    throw new Error('not implemented');
  }
  async quit(): Promise<void> {
    throw new Error('not implemented');
  }
  get name(): string {
    throw new Error('not implemented');
  }
}
