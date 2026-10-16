/**
 * PGN parsing via chess.js. See docs/ARCHITECTURE.md (module "pgn").
 *
 * chess.js 1.4 keeps brace comments while loading a PGN and exposes them via
 * `getComments()` keyed by the FEN of the position the comment is attached to
 * (i.e. the position AFTER the move it follows). Since the fullmove counter
 * is part of the FEN, every ply of a game has a distinct FEN, so the FEN is a
 * safe key to map a move to its clock comment.
 */
import { Chess, DEFAULT_POSITION } from 'chess.js';
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

/** PGN game-termination markers (also what chess.com appends to the movetext). */
const RESULT_TOKEN = /(?:^|\s)(?:1-0|0-1|1\/2-1\/2|\*)\s*$/;

/** `[%clk 0:04:58.8]`, `[%clk 1:02:03]`, `[%clk 4:58]` (hours optional). */
const CLOCK_RE = /\[%clk\s+(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)\s*\]/;

/** Matches the start of a move-list suffix in a chess.com ECOUrl slug, e.g. `...3.Bf4`, `-2.Bf4`, `-2...Nf6`. */
const ECO_URL_MOVELIST_RE = /(?:\.\.\.|-)\d+\.(?:\.\.)?/;

/**
 * Parse a chess.com `[%clk h:mm:ss(.t)]` comment into seconds.
 * Returns `undefined` when the comment carries no clock.
 */
export function parseClockSeconds(comment: string): number | undefined {
  const m = CLOCK_RE.exec(comment);
  if (!m) return undefined;
  const hours = m[1] !== undefined ? Number(m[1]) : 0;
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return undefined;
  }
  // Round to milliseconds to avoid float noise like 298.79999999999995.
  return Math.round((hours * 3600 + minutes * 60 + seconds) * 1000) / 1000;
}

/**
 * Normalise a PGN string before handing it to chess.js:
 * - unify line endings,
 * - drop a trailing game-termination marker (chess.com appends `1-0`, `0-1`,
 *   `1/2-1/2` or `*` after the last clock comment; chess.js tolerates it, but
 *   stripping it keeps the parser input uniform regardless of formatting).
 */
function normalisePgn(pgn: string): string {
  let text = pgn.replace(/\r\n?/g, '\n').trim();
  const resultMatch = RESULT_TOKEN.exec(text);
  if (resultMatch) {
    text = text.slice(0, resultMatch.index).trimEnd();
  }
  return text;
}

function uciOf(move: { from: string; to: string; promotion?: string }): string {
  return `${move.from}${move.to}${move.promotion ?? ''}`;
}

export function parsePgn(pgn: string): ParsedGame {
  if (typeof pgn !== 'string' || pgn.trim().length === 0) {
    throw new Error('Unable to parse PGN: input is empty');
  }

  const text = normalisePgn(pgn);
  const chess = new Chess();
  try {
    chess.loadPgn(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to parse PGN: ${reason}`);
  }

  const headers = { ...chess.getHeaders() };

  const commentByFen = new Map<string, string>();
  for (const { fen, comment } of chess.getComments()) {
    commentByFen.set(fen, comment);
  }

  const history = chess.history({ verbose: true });
  const moves: ParsedMove[] = history.map((m, i) => {
    const parsed: ParsedMove = {
      ply: i + 1,
      color: m.color,
      san: m.san,
      uci: uciOf(m),
      fenBefore: m.before,
      fenAfter: m.after,
    };
    const comment = commentByFen.get(m.after);
    if (comment !== undefined) {
      const clock = parseClockSeconds(comment);
      if (clock !== undefined) parsed.clockSeconds = clock;
    }
    return parsed;
  });

  const fenHeader = headers.FEN?.trim();
  const initialFen = fenHeader && fenHeader.length > 0 ? fenHeader : moves[0]?.fenBefore ?? DEFAULT_POSITION;

  return { headers, moves, initialFen };
}

/** chess.com ECOUrl -> human name, e.g. ".../Modern-Defense-with-1-d4...3.Bf4" -> "Modern Defense with 1 d4". */
export function openingNameFromEcoUrl(url: string): string {
  if (typeof url !== 'string') return '';
  // Drop query string / fragment, then take the last non-empty path segment.
  const path = url.split(/[?#]/, 1)[0] ?? '';
  const segments = path.split('/').filter((s) => s.length > 0);
  let slug = segments[segments.length - 1] ?? '';
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // keep the raw slug when it is not valid percent-encoding
  }

  const moveList = ECO_URL_MOVELIST_RE.exec(slug);
  if (moveList) {
    slug = slug.slice(0, moveList.index);
  }

  return slug
    .replace(/\.{3}/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
