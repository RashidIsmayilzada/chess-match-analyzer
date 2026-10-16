/**
 * Opening book backed by the Lichess chess-openings TSVs. See docs/ARCHITECTURE.md (module "openings").
 *
 * The book keeps every line in file order and additionally indexes them in a trie keyed by
 * normalised SAN, so prefix queries (`isBookMove`, `longestMatch`, `lookupByMoves`) cost
 * O(plies) regardless of the number of lines.
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpeningRef } from '../types.js';

export interface OpeningLine extends OpeningRef {
  /** Moves in SAN, e.g. ["e4", "e5", "Nf3"]. */
  moves: string[];
  /** Original PGN string from the dataset, e.g. "1. e4 e5 2. Nf3". */
  pgn: string;
}

/** File names that make up the default dataset, in load order. */
export const DEFAULT_OPENINGS_FILES = ['a.tsv', 'b.tsv', 'c.tsv', 'd.tsv', 'e.tsv'] as const;

const DEFAULT_SEARCH_LIMIT = 50;

interface TrieNode {
  children: Map<string, TrieNode>;
  /** The line that ends exactly at this node (first one in file order wins). */
  line?: OpeningLine;
}

function newNode(): TrieNode {
  return { children: new Map() };
}

/**
 * Normalise a SAN token for trie keys so that lookups are tolerant of cosmetic differences
 * between the dataset and whatever produced the game's SAN (chess.js, chess.com PGN, ...):
 * check/mate suffixes, annotation glyphs and zero-style castling are all dropped.
 */
export function normalizeSan(san: string): string {
  let s = san.trim();
  // Trailing check / mate markers and annotation glyphs: "Bb5+", "Nxe5!?", "Qxf7#".
  s = s.replace(/[+#!?]+$/, '');
  // Zero-style castling.
  if (/^0-0-0$/.test(s)) return 'O-O-O';
  if (/^0-0$/.test(s)) return 'O-O';
  return s;
}

function toRef(line: OpeningLine): OpeningRef {
  return { eco: line.eco, name: line.name };
}

export class OpeningBook {
  private readonly lines: OpeningLine[];
  private readonly root: TrieNode = newNode();
  private readonly byEcoIndex = new Map<string, OpeningLine[]>();
  /** Lines sorted by eco, then name, then file order (stable). Built lazily for `search`. */
  private sorted: OpeningLine[] | undefined;

  constructor(lines: OpeningLine[]) {
    this.lines = lines.slice();
    for (const line of this.lines) {
      this.insert(line);
      const eco = line.eco.toUpperCase();
      let bucket = this.byEcoIndex.get(eco);
      if (!bucket) {
        bucket = [];
        this.byEcoIndex.set(eco, bucket);
      }
      bucket.push(line);
    }
  }

  private insert(line: OpeningLine): void {
    let node = this.root;
    for (const san of line.moves) {
      const key = normalizeSan(san);
      let next = node.children.get(key);
      if (!next) {
        next = newNode();
        node.children.set(key, next);
      }
      node = next;
    }
    // Keep the first line in file order if the dataset ever contains the same move list twice.
    if (!node.line) node.line = line;
  }

  /** Walk the trie along `sanMoves`; returns undefined as soon as a move leaves the book. */
  private walk(sanMoves: readonly string[]): TrieNode | undefined {
    let node: TrieNode | undefined = this.root;
    for (const san of sanMoves) {
      node = node.children.get(normalizeSan(san));
      if (!node) return undefined;
    }
    return node;
  }

  /** Exact match: the opening whose move list equals `sanMoves`. */
  lookupByMoves(sanMoves: string[]): OpeningRef | undefined {
    const node = this.walk(sanMoves);
    return node?.line ? toRef(node.line) : undefined;
  }

  /** True if `sanMovesSoFar + san` is a prefix of (or equal to) at least one line in the book. */
  isBookMove(sanMovesSoFar: string[], san: string): boolean {
    const node = this.walk(sanMovesSoFar);
    if (!node) return false;
    return node.children.has(normalizeSan(san));
  }

  /**
   * Longest line that is a prefix of `sanMoves`, and how many plies of it matched.
   * Ties between lines of equal length cannot occur in the trie (one node per move list);
   * when the dataset repeats a move list the first line in file order is kept.
   */
  longestMatch(sanMoves: string[]): { opening: OpeningRef; plies: number } | undefined {
    let node: TrieNode | undefined = this.root;
    let best: { line: OpeningLine; plies: number } | undefined;
    let depth = 0;
    for (const san of sanMoves) {
      node = node.children.get(normalizeSan(san));
      if (!node) break;
      depth += 1;
      if (node.line) best = { line: node.line, plies: depth };
    }
    return best ? { opening: toRef(best.line), plies: best.plies } : undefined;
  }

  /**
   * Case-insensitive substring search over name and ECO. Results are ordered by ECO, then
   * name, then dataset order; `limit` defaults to 50. An empty query returns the first
   * `limit` lines in that order.
   */
  search(query: string, limit: number = DEFAULT_SEARCH_LIMIT): OpeningLine[] {
    const q = query.trim().toLowerCase();
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_SEARCH_LIMIT;
    const out: OpeningLine[] = [];
    for (const line of this.sortedLines()) {
      if (q === '' || line.name.toLowerCase().includes(q) || line.eco.toLowerCase().includes(q)) {
        out.push(line);
        if (out.length >= max) break;
      }
    }
    return out;
  }

  /** All lines with exactly this ECO code (case-insensitive), in dataset order. */
  byEco(eco: string): OpeningLine[] {
    const bucket = this.byEcoIndex.get(eco.trim().toUpperCase());
    return bucket ? bucket.slice() : [];
  }

  /** Every line, in dataset order. */
  list(): OpeningLine[] {
    return this.lines.slice();
  }

  get size(): number {
    return this.lines.length;
  }

  private sortedLines(): OpeningLine[] {
    if (!this.sorted) {
      // Array.prototype.sort is stable, so equal (eco, name) pairs keep file order.
      this.sorted = this.lines.slice().sort((a, b) => {
        if (a.eco !== b.eco) return a.eco < b.eco ? -1 : 1;
        if (a.name !== b.name) return a.name < b.name ? -1 : 1;
        return 0;
      });
    }
    return this.sorted;
  }
}

/** Matches move-number tokens: "1.", "12.", "3...", and also a bare "..." continuation. */
const MOVE_NUMBER_RE = /^\d+\.+$|^\.\.\.$/;
/** Matches game-result tokens that occasionally terminate a PGN movetext. */
const RESULT_RE = /^(1-0|0-1|1\/2-1\/2|\*)$/;
/** Numeric annotation glyphs such as "$1". */
const NAG_RE = /^\$\d+$/;

/**
 * Turn a PGN movetext like "1. e4 e5 2. Nf3 Nc6" into ["e4", "e5", "Nf3", "Nc6"].
 * Also tolerates "1.e4" (number glued to the move), "2...", result tokens and NAGs.
 */
export function pgnToSanList(pgn: string): string[] {
  const moves: string[] = [];
  for (const rawToken of pgn.trim().split(/\s+/)) {
    if (rawToken === '') continue;
    // "1.e4" / "2...Nf6": drop the glued move number.
    const token = rawToken.replace(/^\d+\.+(?=[^.\s])/, '');
    if (token === '' || MOVE_NUMBER_RE.test(token) || RESULT_RE.test(token) || NAG_RE.test(token)) {
      continue;
    }
    moves.push(token);
  }
  return moves;
}

/** Parse the TSV format "eco\tname\tpgn" (header row included). */
export function parseOpeningsTsv(tsv: string): OpeningLine[] {
  const lines: OpeningLine[] = [];
  const rows = tsv.split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? '';
    if (row.trim() === '') continue;
    const cols = row.split('\t');
    if (cols.length < 3) {
      throw new Error(`openings TSV: expected 3 tab-separated columns on line ${i + 1}, got ${cols.length}`);
    }
    const eco = (cols[0] ?? '').trim();
    const name = (cols[1] ?? '').trim();
    const pgn = (cols[2] ?? '').trim();
    // Header row (anywhere, so concatenated files also parse).
    if (eco.toLowerCase() === 'eco' && name.toLowerCase() === 'name' && pgn.toLowerCase() === 'pgn') {
      continue;
    }
    const moves = pgnToSanList(pgn);
    if (eco === '' || name === '' || moves.length === 0) {
      throw new Error(`openings TSV: malformed row on line ${i + 1}: ${JSON.stringify(row)}`);
    }
    lines.push({ eco, name, pgn, moves });
  }
  return lines;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/**
 * Directory of the nearest ancestor of this module that contains a package.json
 * (packages/core, whether we run from src/ via a TS loader or from dist/).
 */
async function findPackageRoot(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (await isFile(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error('openings: could not locate package.json above ' + fileURLToPath(import.meta.url));
    }
    dir = parent;
  }
}

/** Resolve the default `<repo>/data/openings` directory relative to this package. */
export async function defaultOpeningsDir(): Promise<string> {
  const packageRoot = await findPackageRoot();
  return resolve(packageRoot, '..', '..', 'data', 'openings');
}

/** Load a..e.tsv from `dataDir` (default: <repo>/data/openings). */
export async function loadDefaultBook(dataDir?: string): Promise<OpeningBook> {
  const dir = dataDir ? resolve(dataDir) : await defaultOpeningsDir();
  if (!(await isDirectory(dir))) {
    throw new Error(`openings: data directory not found: ${dir}`);
  }
  const contents = await Promise.all(
    DEFAULT_OPENINGS_FILES.map(async (name) => {
      const file = join(dir, name);
      try {
        return await readFile(file, 'utf8');
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`openings: could not read ${file}: ${reason}`);
      }
    }),
  );
  const lines: OpeningLine[] = [];
  for (const tsv of contents) lines.push(...parseOpeningsTsv(tsv));
  return new OpeningBook(lines);
}
