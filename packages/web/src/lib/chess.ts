import { Chess } from 'chess.js';
import type { Color } from '@chess-analyzer/core';
import type { Key } from '@lichess-org/chessground/types';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * One half-move of a game as the UI needs it. `ply` is 1-based from the game's start position
 * (as in core's `MoveAnalysis.ply`); for a game starting from a FEN, add `plyOffsetFromFen` to get
 * the absolute ply that move numbers and the white/black column are derived from.
 */
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

/**
 * Number of plies "already played" before a game that starts from `fen`: 0 for the standard
 * start position, 1 when black is to move at move 1, `(fullmove - 1) * 2 + (black ? 1 : 0)` in
 * general. Game plies (1-based) plus this offset give the absolute ply used for move numbers.
 */
export function plyOffsetFromFen(fen: string): number {
  const fields = fen.trim().split(/\s+/);
  const turn = fields[1] === 'b' ? 1 : 0;
  const fullmove = Number(fields[5]);
  const moveNumber = Number.isInteger(fullmove) && fullmove >= 1 ? fullmove : 1;
  return (moveNumber - 1) * 2 + turn;
}

/** True when the (game) ply, shifted by the start offset, is a white move. */
export function isWhitePly(ply: number, plyOffset = 0): boolean {
  return (ply + plyOffset) % 2 === 1;
}

/** Move number of a (game) ply, shifted by the start offset. */
export function moveNumber(ply: number, plyOffset = 0): number {
  return Math.ceil((ply + plyOffset) / 2);
}

/** Move number label for a ply: ply 1 -> "1.", ply 2 -> "1...". */
export function plyLabel(ply: number, plyOffset = 0): string {
  const n = moveNumber(ply, plyOffset);
  return isWhitePly(ply, plyOffset) ? `${n}.` : `${n}...`;
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

/**
 * Render a SAN line that starts at (game) ply `startPly` as "12. Nf3 Nc6 13. Bb5" text; a line
 * starting with a black move begins "12... Nc6".
 */
export function sanLineToText(line: string[], startPly: number, plyOffset = 0): string {
  const parts: string[] = [];
  line.forEach((san, i) => {
    const ply = startPly + i;
    if (isWhitePly(ply, plyOffset)) parts.push(`${moveNumber(ply, plyOffset)}. ${san}`);
    else if (i === 0) parts.push(`${moveNumber(ply, plyOffset)}... ${san}`);
    else parts.push(san);
  });
  return parts.join(' ');
}
