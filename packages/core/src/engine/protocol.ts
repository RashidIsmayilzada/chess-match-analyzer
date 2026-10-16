/**
 * Pure helpers for the UCI text protocol: parsing `info` / `bestmove` / `id` lines
 * and normalising scores to white POV. No I/O here, so everything is unit-testable
 * without an engine binary.
 */
import type { Color, EngineScore } from '../types.js';

/** A parsed `info` line. Only the fields we care about. */
export interface UciInfo {
  depth?: number;
  seldepth?: number;
  multipv?: number;
  /** Score from the SIDE TO MOVE's point of view, exactly as the engine reported it. */
  score?: EngineScore;
  /** True when the score carried a `lowerbound` / `upperbound` flag (aspiration-window noise). */
  bound: boolean;
  nodes?: number;
  nps?: number;
  timeMs?: number;
  /** Principal variation in UCI notation (may be empty). */
  pv: string[];
  /** Free-form `info string ...` payload, when present. */
  string?: string;
}

/** Keys whose value is a single integer token. */
const INT_KEYS = new Set([
  'depth',
  'seldepth',
  'multipv',
  'nodes',
  'nps',
  'time',
  'hashfull',
  'tbhits',
  'currmovenumber',
  'cpuload',
]);

/** Keys whose value is a single non-numeric token. */
const WORD_KEYS = new Set(['currmove']);

function toInt(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  const n = Number.parseInt(token, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse an `info ...` line. Returns `undefined` for lines that are not `info` lines.
 * Unknown keys are skipped token by token, which is the best one can do with UCI's
 * untyped key/value stream.
 */
export function parseInfoLine(line: string): UciInfo | undefined {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'info') return undefined;

  const info: UciInfo = { bound: false, pv: [] };
  let i = 1;
  while (i < tokens.length) {
    const key = tokens[i]!;
    if (INT_KEYS.has(key)) {
      const v = toInt(tokens[i + 1]);
      if (key === 'depth') info.depth = v;
      else if (key === 'seldepth') info.seldepth = v;
      else if (key === 'multipv') info.multipv = v;
      else if (key === 'nodes') info.nodes = v;
      else if (key === 'nps') info.nps = v;
      else if (key === 'time') info.timeMs = v;
      i += 2;
    } else if (WORD_KEYS.has(key)) {
      i += 2;
    } else if (key === 'score') {
      const kind = tokens[i + 1];
      const value = toInt(tokens[i + 2]);
      i += 3;
      if ((kind === 'cp' || kind === 'mate') && value !== undefined) {
        info.score = { type: kind, value };
      }
      // Optional bound flag directly after the value.
      const flag = tokens[i];
      if (flag === 'lowerbound' || flag === 'upperbound') {
        info.bound = true;
        i += 1;
      }
    } else if (key === 'wdl') {
      i += 4;
    } else if (key === 'refutation' || key === 'currline') {
      // Both consume the rest of the line; we do not use them.
      break;
    } else if (key === 'pv') {
      info.pv = tokens.slice(i + 1).filter((t) => t.length > 0);
      break;
    } else if (key === 'string') {
      info.string = tokens.slice(i + 1).join(' ');
      break;
    } else {
      // Unknown key: skip it (and nothing else) and keep going.
      i += 1;
    }
  }
  return info;
}

/**
 * Parse a `bestmove ...` line. Returns the move in UCI notation, `null` when the engine
 * reported `(none)` (no legal moves), or `undefined` when the line is not a bestmove line.
 */
export function parseBestmoveLine(line: string): string | null | undefined {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'bestmove') return undefined;
  const move = tokens[1];
  if (move === undefined || move === '(none)' || move === '0000' || move === 'NULL') return null;
  return move;
}

/** Extract the engine name from an `id name ...` line, or `undefined`. */
export function parseIdNameLine(line: string): string | undefined {
  const m = /^id\s+name\s+(.+)$/.exec(line.trim());
  return m ? m[1]!.trim() : undefined;
}

/** Side to move of a FEN string. Defaults to white when the field is missing or malformed. */
export function sideToMove(fen: string): Color {
  const field = fen.trim().split(/\s+/)[1];
  return field === 'b' ? 'b' : 'w';
}

/**
 * Convert a score reported from the side to move's perspective into white POV.
 * Both cp and mate values flip sign when black is to move.
 */
export function toWhitePov(score: EngineScore, mover: Color): EngineScore {
  if (mover === 'w') return { type: score.type, value: score.value };
  // `+ 0` turns -0 into 0 so equality checks stay simple.
  return { type: score.type, value: -score.value + 0 };
}
