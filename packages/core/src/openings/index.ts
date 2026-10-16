/**
 * Opening book backed by the Lichess chess-openings TSVs. See docs/ARCHITECTURE.md (module "openings").
 */
import type { OpeningRef } from '../types.js';

export interface OpeningLine extends OpeningRef {
  /** Moves in SAN, e.g. ["e4", "e5", "Nf3"]. */
  moves: string[];
  /** Original PGN string from the dataset, e.g. "1. e4 e5 2. Nf3". */
  pgn: string;
}

export class OpeningBook {
  constructor(_lines: OpeningLine[]) {
    throw new Error('not implemented');
  }
  /** Exact match: the opening whose move list equals `sanMoves`. */
  lookupByMoves(_sanMoves: string[]): OpeningRef | undefined {
    throw new Error('not implemented');
  }
  /** True if `sanMovesSoFar + san` is a prefix of (or equal to) at least one line in the book. */
  isBookMove(_sanMovesSoFar: string[], _san: string): boolean {
    throw new Error('not implemented');
  }
  /** Longest line that is a prefix of `sanMoves`, and how many plies of it matched. */
  longestMatch(_sanMoves: string[]): { opening: OpeningRef; plies: number } | undefined {
    throw new Error('not implemented');
  }
  /** Case-insensitive search over name and ECO. */
  search(_query: string, _limit?: number): OpeningLine[] {
    throw new Error('not implemented');
  }
  byEco(_eco: string): OpeningLine[] {
    throw new Error('not implemented');
  }
  list(): OpeningLine[] {
    throw new Error('not implemented');
  }
  get size(): number {
    throw new Error('not implemented');
  }
}

/** Parse the TSV format "eco\tname\tpgn" (header row included). */
export function parseOpeningsTsv(_tsv: string): OpeningLine[] {
  throw new Error('not implemented');
}

/** Load a..e.tsv from `dataDir` (default: <repo>/data/openings). */
export async function loadDefaultBook(_dataDir?: string): Promise<OpeningBook> {
  throw new Error('not implemented');
}
