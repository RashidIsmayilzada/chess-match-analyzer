import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OpeningBook,
  defaultOpeningsDir,
  loadDefaultBook,
  normalizeSan,
  parseOpeningsTsv,
  pgnToSanList,
  type OpeningLine,
} from './index.js';

const SAMPLE_TSV = [
  'eco\tname\tpgn',
  'A00\tAmar Opening\t1. Nh3',
  "A00\tAmar Opening: Paris Gambit\t1. Nh3 d5 2. g3 e5 3. f4",
  'C40\tKing\'s Knight Opening\t1. e4 e5 2. Nf3',
  'C44\tKing\'s Knight Opening: Normal Variation\t1. e4 e5 2. Nf3 Nc6',
  'D00\tQueen\'s Pawn Game: Accelerated London System\t1. d4 d5 2. Bf4',
  'C00\tFrench Defense\t1. e4 e6',
  'B90\tSicilian Defense: Najdorf Variation\t1. e4 c5 2. Nf3 d6 3. d4 cxd4 4. Nxd4 Nf6 5. Nc3 a6',
  '',
].join('\n');

describe('pgnToSanList', () => {
  it('strips move numbers', () => {
    expect(pgnToSanList('1. e4 e5 2. Nf3 Nc6')).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
  });

  it('tolerates glued numbers, black continuations, results and NAGs', () => {
    expect(pgnToSanList('1.e4 e5 2.Nf3 2... Nc6 3...Nf6 $1 1-0')).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Nf6']);
  });

  it('keeps castling and check markers as written', () => {
    expect(pgnToSanList('5. O-O fxg3 6. hxg3 Bb5+')).toEqual(['O-O', 'fxg3', 'hxg3', 'Bb5+']);
  });
});

describe('normalizeSan', () => {
  it('drops check, mate and annotation suffixes and zero-castling', () => {
    expect(normalizeSan('Bb5+')).toBe('Bb5');
    expect(normalizeSan('Qxf7#')).toBe('Qxf7');
    expect(normalizeSan('Nxe5!?')).toBe('Nxe5');
    expect(normalizeSan('0-0')).toBe('O-O');
    expect(normalizeSan('0-0-0')).toBe('O-O-O');
    expect(normalizeSan('exd8=Q+')).toBe('exd8=Q');
  });
});

describe('parseOpeningsTsv', () => {
  it('parses rows, skips the header and blank lines, keeps file order', () => {
    const lines = parseOpeningsTsv(SAMPLE_TSV);
    expect(lines).toHaveLength(7);
    expect(lines[0]).toEqual({ eco: 'A00', name: 'Amar Opening', pgn: '1. Nh3', moves: ['Nh3'] });
    expect(lines[3]).toEqual({
      eco: 'C44',
      name: "King's Knight Opening: Normal Variation",
      pgn: '1. e4 e5 2. Nf3 Nc6',
      moves: ['e4', 'e5', 'Nf3', 'Nc6'],
    });
    expect(lines[6]?.moves).toEqual(['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']);
  });

  it('handles CRLF line endings', () => {
    const lines = parseOpeningsTsv('eco\tname\tpgn\r\nA00\tAmar Opening\t1. Nh3\r\n');
    expect(lines).toEqual([{ eco: 'A00', name: 'Amar Opening', pgn: '1. Nh3', moves: ['Nh3'] }]);
  });

  it('rejects rows with too few columns', () => {
    expect(() => parseOpeningsTsv('eco\tname\tpgn\nA00\tAmar Opening')).toThrow(/line 2/);
  });

  it('rejects rows with an empty move list', () => {
    expect(() => parseOpeningsTsv('eco\tname\tpgn\nA00\tNothing\t')).toThrow(/malformed row on line 2/);
  });
});

describe('OpeningBook (sample data)', () => {
  const book = new OpeningBook(parseOpeningsTsv(SAMPLE_TSV));

  it('reports size and list in file order', () => {
    expect(book.size).toBe(7);
    expect(book.list().map((l) => l.eco)).toEqual(['A00', 'A00', 'C40', 'C44', 'D00', 'C00', 'B90']);
  });

  it('list() returns a copy', () => {
    const a = book.list();
    a.pop();
    expect(book.size).toBe(7);
  });

  it('lookupByMoves is exact', () => {
    expect(book.lookupByMoves(['e4', 'e5', 'Nf3'])).toEqual({ eco: 'C40', name: "King's Knight Opening" });
    expect(book.lookupByMoves(['e4', 'e5'])).toBeUndefined();
    expect(book.lookupByMoves(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'])).toBeUndefined();
    expect(book.lookupByMoves([])).toBeUndefined();
  });

  it('isBookMove checks prefixes of any line', () => {
    expect(book.isBookMove([], 'e4')).toBe(true);
    expect(book.isBookMove([], 'a4')).toBe(false);
    expect(book.isBookMove(['d4', 'd5'], 'Bf4')).toBe(true);
    expect(book.isBookMove(['e4', 'e5', 'Nf3', 'Nc6'], 'Bb5')).toBe(false);
    expect(book.isBookMove(['e4', 'a6'], 'd4')).toBe(false);
  });

  it('isBookMove tolerates check suffixes and zero-castling in the input', () => {
    const b = new OpeningBook(parseOpeningsTsv('eco\tname\tpgn\nX00\tTest\t1. e4 e5 2. Bc4 Nf6 3. Bxf7+ Kxf7 4. O-O'));
    expect(b.isBookMove(['e4', 'e5', 'Bc4', 'Nf6'], 'Bxf7')).toBe(true);
    expect(b.isBookMove(['e4', 'e5', 'Bc4', 'Nf6', 'Bxf7', 'Kxf7'], '0-0')).toBe(true);
    expect(b.lookupByMoves(['e4', 'e5', 'Bc4', 'Nf6', 'Bxf7+', 'Kxf7', 'O-O'])).toEqual({ eco: 'X00', name: 'Test' });
  });

  it('longestMatch returns the deepest line that prefixes the moves', () => {
    expect(book.longestMatch(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'])).toEqual({
      opening: { eco: 'C44', name: "King's Knight Opening: Normal Variation" },
      plies: 4,
    });
    expect(book.longestMatch(['e4', 'e5', 'Nf3', 'Nf6'])).toEqual({
      opening: { eco: 'C40', name: "King's Knight Opening" },
      plies: 3,
    });
    expect(book.longestMatch(['d4', 'Nf6'])).toBeUndefined();
    expect(book.longestMatch([])).toBeUndefined();
  });

  it('longestMatch keeps the first line in file order when a move list is duplicated', () => {
    const dup = new OpeningBook(
      parseOpeningsTsv('eco\tname\tpgn\nA01\tFirst\t1. b3\nA01\tSecond\t1. b3\n'),
    );
    expect(dup.longestMatch(['b3', 'e5'])).toEqual({ opening: { eco: 'A01', name: 'First' }, plies: 1 });
    expect(dup.lookupByMoves(['b3'])).toEqual({ eco: 'A01', name: 'First' });
  });

  it('search is case-insensitive over name and eco, sorted by eco then name', () => {
    expect(book.search('knight').map((l) => l.name)).toEqual([
      "King's Knight Opening",
      "King's Knight Opening: Normal Variation",
    ]);
    expect(book.search('c4').map((l) => l.eco)).toEqual(['C40', 'C44']);
    expect(book.search('LONDON').map((l) => l.name)).toEqual(["Queen's Pawn Game: Accelerated London System"]);
    expect(book.search('nothing here')).toEqual([]);
  });

  it('search respects the limit (default 50) and sorts the empty query', () => {
    expect(book.search('', 2).map((l) => l.eco)).toEqual(['A00', 'A00']);
    expect(book.search('').map((l) => l.eco)).toEqual(['A00', 'A00', 'B90', 'C00', 'C40', 'C44', 'D00']);
    const many: OpeningLine[] = Array.from({ length: 60 }, (_, i) => ({
      eco: 'A00',
      name: `Line ${String(i).padStart(2, '0')}`,
      pgn: '1. Nh3',
      moves: ['Nh3'],
    }));
    expect(new OpeningBook(many).search('line')).toHaveLength(50);
    expect(new OpeningBook(many).search('line', 10)).toHaveLength(10);
  });

  it('byEco returns lines for that code in file order', () => {
    expect(book.byEco('A00').map((l) => l.name)).toEqual(['Amar Opening', 'Amar Opening: Paris Gambit']);
    expect(book.byEco('a00')).toHaveLength(2);
    expect(book.byEco('Z99')).toEqual([]);
  });
});

describe('loadDefaultBook (real dataset)', () => {
  let book: OpeningBook;

  beforeAll(async () => {
    book = await loadDefaultBook();
  });

  it('resolves the default data directory to <repo>/data/openings', async () => {
    expect(await defaultOpeningsDir()).toMatch(/[\\/]data[\\/]openings$/);
  });

  it('loads more than 3000 lines', () => {
    expect(book.size).toBeGreaterThan(3000);
    expect(book.list()).toHaveLength(book.size);
  });

  it("finds King's Knight Opening by exact moves, matching the dataset row", () => {
    const row = book.list().find((l) => l.moves.join(' ') === 'e4 e5 Nf3');
    expect(row).toBeDefined();
    expect(book.lookupByMoves(['e4', 'e5', 'Nf3'])).toEqual({ eco: row!.eco, name: row!.name });
    expect(row!.eco).toBe('C40');
    expect(row!.name).toBe("King's Knight Opening");
  });

  it('isBookMove(["d4","d5"], "Bf4") is true (London System)', () => {
    expect(book.isBookMove(['d4', 'd5'], 'Bf4')).toBe(true);
  });

  it('longestMatch finds the Najdorf with 10 plies once the game leaves the book', () => {
    // 6. a3 is not in the dataset, so the deepest matching line is the bare Najdorf (10 plies).
    const najdorf = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'];
    expect(book.isBookMove(najdorf, 'a3')).toBe(false);
    expect(book.longestMatch([...najdorf, 'a3', 'e5'])).toEqual({
      opening: { eco: 'B90', name: 'Sicilian Defense: Najdorf Variation' },
      plies: 10,
    });
    expect(book.lookupByMoves(najdorf)).toEqual({ eco: 'B90', name: 'Sicilian Defense: Najdorf Variation' });
  });

  it('longestMatch prefers the deeper line when the next move is still in the book', () => {
    // 6. h3 is the Adams Attack, a separate dataset row one ply deeper than the bare Najdorf.
    const moves = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6', 'h3'];
    expect(book.isBookMove(moves.slice(0, 10), 'h3')).toBe(true);
    expect(book.longestMatch(moves)).toEqual({
      opening: { eco: 'B90', name: 'Sicilian Defense: Najdorf Variation, Adams Attack' },
      plies: 11,
    });
  });

  it("search('london') includes 'London System'", () => {
    const names = book.search('london').map((l) => l.name);
    expect(names).toContain('London System');
    expect(names.length).toBeLessThanOrEqual(50);
  });

  it('byEco("B90") is non-empty and every line has that eco', () => {
    const lines = book.byEco('B90');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.eco === 'B90')).toBe(true);
  });

  it('every book line is itself reachable via isBookMove and lookupByMoves', () => {
    for (const line of book.list()) {
      const prefix = line.moves.slice(0, -1);
      const last = line.moves[line.moves.length - 1]!;
      expect(book.isBookMove(prefix, last)).toBe(true);
      expect(book.lookupByMoves(line.moves)).toBeDefined();
    }
  });
});

describe('loadDefaultBook (explicit dataDir)', () => {
  it('reads a..e.tsv from the given directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openings-'));
    for (const f of ['a', 'b', 'c', 'd', 'e']) {
      await writeFile(join(dir, `${f}.tsv`), `eco\tname\tpgn\n${f.toUpperCase()}00\tLine ${f}\t1. ${f}3\n`);
    }
    const book = await loadDefaultBook(dir);
    expect(book.size).toBe(5);
    expect(book.lookupByMoves(['c3'])).toEqual({ eco: 'C00', name: 'Line c' });
  });

  it('fails clearly when the directory or a file is missing', async () => {
    await expect(loadDefaultBook('/definitely/not/here')).rejects.toThrow(/data directory not found/);
    const dir = await mkdtemp(join(tmpdir(), 'openings-partial-'));
    await writeFile(join(dir, 'a.tsv'), 'eco\tname\tpgn\nA00\tX\t1. a3\n');
    await expect(loadDefaultBook(dir)).rejects.toThrow(/could not read .*b\.tsv/);
  });
});
