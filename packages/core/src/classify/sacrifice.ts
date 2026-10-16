export interface SacrificeResult {
  isSacrifice: boolean;
  /** Net material (pawn units) the mover leaves en prise and cannot recoup by recapture. 0 if none. */
  value: number;
  /** Squares of the sacrificed pieces, for display. */
  squares: string[];
}

/** Detect whether playing `uci` in `fenBefore` sacrifices material. See docs/ARCHITECTURE.md. */
export function detectSacrifice(_fenBefore: string, _uci: string): SacrificeResult {
  throw new Error('not implemented');
}
