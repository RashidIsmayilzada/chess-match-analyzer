/**
 * PGN parsing via chess.js. See docs/ARCHITECTURE.md (module "pgn").
 */
import type { Color } from '../types.js';

export interface ParsedMove {
  ply: number;
  color: Color;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  /** From chess.com `{[%clk h:mm:ss.s]}` comments, in seconds. */
  clockSeconds?: number;
}

export interface ParsedGame {
  headers: Record<string, string>;
  moves: ParsedMove[];
  /** Starting FEN (standard start position unless a FEN header is present). */
  initialFen: string;
}

export function parsePgn(_pgn: string): ParsedGame {
  throw new Error('not implemented');
}

/** chess.com ECOUrl -> human name, e.g. ".../Modern-Defense-with-1-d4...3.Bf4" -> "Modern Defense with 1 d4". */
export function openingNameFromEcoUrl(_url: string): string {
  throw new Error('not implemented');
}
