import { Chess } from 'chess.js';
import type { Color } from '@chess-analyzer/core';
import type { Key } from '@lichess-org/chessground/types';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** One half-move of a game as the UI needs it. Ply is 1-based. */
export interface Ply {
  ply: number;
  color: Color;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
}

export function uciToKeys(uci: string): [Key, Key] | undefined {
  if (uci.length < 4) return undefined;
  const from = uci.slice(0, 2) as Key;
  const to = uci.slice(2, 4) as Key;
  if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) return undefined;
  return [from, to];
}

export function turnFromFen(fen: string): Color {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

/** Whether the side to move in `fen` is in check. */
export function isCheck(fen: string): boolean {
  try {
    return new Chess(fen).isCheck();
  } catch {
    return false;
  }
}

/** Move number label for a ply: ply 1 -> "1.", ply 2 -> "1...". */
export function plyLabel(ply: number): string {
  const n = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${n}.` : `${n}...`;
}

/** Parse a PGN (chess.com style with {[%clk]} comments) into plies using chess.js. */
export function parsePgnPlies(pgn: string): Ply[] {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const history = chess.history({ verbose: true });
  return history.map((m, i) => ({
    ply: i + 1,
    color: m.color,
    san: m.san,
    uci: m.from + m.to + (m.promotion ?? ''),
    fenBefore: m.before,
    fenAfter: m.after,
  }));
}

/** Parse a bare move list ("1. e4 e5 2. Nf3") into plies. Tolerant of missing numbers. */
export function parseMoveListPlies(moves: string): Ply[] {
  return parsePgnPlies(moves.trim());
}

/** Headers of a PGN as a map. */
export function pgnHeaders(pgn: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^\[(\w+)\s+"([^"]*)"\]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pgn)) !== null) {
    if (m[1] !== undefined && m[2] !== undefined) out[m[1]] = m[2];
  }
  return out;
}

/** Convert a SAN line starting from `fen` into the same SAN list but validated; returns input on failure. */
export function sanLineToText(line: string[], startPly: number): string {
  const parts: string[] = [];
  line.forEach((san, i) => {
    const ply = startPly + i;
    if (ply % 2 === 1) parts.push(`${Math.ceil(ply / 2)}. ${san}`);
    else if (i === 0) parts.push(`${Math.ceil(ply / 2)}... ${san}`);
    else parts.push(san);
  });
  return parts.join(' ');
}
