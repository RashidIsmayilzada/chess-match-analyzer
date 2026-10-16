import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POSITION } from 'chess.js';
import { openingNameFromEcoUrl, parseClockSeconds, parsePgn } from './index.js';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../../data/fixtures/${name}`, import.meta.url)), 'utf8');
}

/** board + side to move + castling + en passant (drops halfmove/fullmove counters). */
function fenCore(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

const FIXTURES = [
  { file: 'game1.pgn', plies: 107, first: 'd4', last: 'Qg1+', white: 'Vladijaquetiado', black: 'xSeven123', eco: 'A45', result: '1-0' },
  { file: 'game2.pgn', plies: 58, first: 'e4', last: 'Qxc3', white: 'Ahmedsabt55', black: 'xSeven123', eco: 'B07', result: '0-1' },
  { file: 'game3.pgn', plies: 79, first: 'd4', last: 'Qg6#', white: 'xSeven123', black: 'tataebeb', eco: 'A40', result: '1-0' },
] as const;

describe('parsePgn with chess.com fixtures', () => {
  for (const fx of FIXTURES) {
    describe(fx.file, () => {
      const game = parsePgn(fixture(fx.file));

      it('exposes the chess.com headers', () => {
        expect(game.headers.White).toBe(fx.white);
        expect(game.headers.Black).toBe(fx.black);
        expect(game.headers.ECO).toBe(fx.eco);
        expect(game.headers.ECOUrl).toMatch(/^https:\/\/www\.chess\.com\/openings\//);
        expect(game.headers.TimeControl).toBe('300');
        expect(game.headers.Result).toBe(fx.result);
      });

      it('parses every move with the expected count and endpoints', () => {
        expect(game.moves).toHaveLength(fx.plies);
        expect(game.moves[0]?.san).toBe(fx.first);
        expect(game.moves[game.moves.length - 1]?.san).toBe(fx.last);
      });

      it('numbers plies from 1 and alternates colours starting with white', () => {
        game.moves.forEach((m, i) => {
          expect(m.ply).toBe(i + 1);
          expect(m.color).toBe(i % 2 === 0 ? 'w' : 'b');
        });
      });

      it('chains fenBefore/fenAfter through the game from the initial position', () => {
        expect(game.initialFen).toBe(DEFAULT_POSITION);
        expect(game.moves[0]?.fenBefore).toBe(DEFAULT_POSITION);
        for (let i = 1; i < game.moves.length; i++) {
          expect(game.moves[i]?.fenBefore).toBe(game.moves[i - 1]?.fenAfter);
        }
      });

      it('produces valid UCI for every move', () => {
        for (const m of game.moves) expect(m.uci).toMatch(UCI_RE);
      });

      it('parses a clock on every move', () => {
        for (const m of game.moves) {
          expect(m.clockSeconds, `ply ${m.ply} (${m.san})`).toBeTypeOf('number');
          expect(m.clockSeconds).toBeGreaterThanOrEqual(0);
          expect(m.clockSeconds).toBeLessThanOrEqual(300);
        }
      });

      it('ends in the CurrentPosition header', () => {
        const last = game.moves[game.moves.length - 1];
        expect(last).toBeDefined();
        expect(fenCore(last!.fenAfter)).toBe(fenCore(game.headers.CurrentPosition!));
      });
    });
  }

  it('game1: specific moves, clocks and the h8=Q promotion', () => {
    const { moves } = parsePgn(fixture('game1.pgn'));
    expect(moves[0]).toMatchObject({ ply: 1, color: 'w', san: 'd4', uci: 'd2d4', clockSeconds: 298.8 });
    expect(moves[1]).toMatchObject({ ply: 2, color: 'b', san: 'Nf6', uci: 'g8f6', clockSeconds: 297.5 });
    // 6... e5 {[%clk 0:04:35]} - clock without fractional seconds
    expect(moves[11]).toMatchObject({ san: 'e5', clockSeconds: 275 });
    // 50. h8=Q {[%clk 0:00:14.2]}
    const promo = moves.find((m) => m.san === 'h8=Q');
    expect(promo).toMatchObject({ ply: 99, color: 'w', uci: 'h7h8q', clockSeconds: 14.2 });
    // last move 54. Qg1+ {[%clk 0:00:03.8]}
    expect(moves[106]).toMatchObject({ san: 'Qg1+', clockSeconds: 3.8 });
  });

  it('game3: final move is checkmate with its clock', () => {
    const { moves } = parsePgn(fixture('game3.pgn'));
    expect(moves[78]).toMatchObject({ ply: 79, color: 'w', san: 'Qg6#', uci: 'f5g6', clockSeconds: 84.2 });
  });
});

describe('parsePgn edge cases', () => {
  it('parses a bare movetext without headers or clocks', () => {
    const game = parsePgn('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
    expect(game.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
    expect(game.moves.every((m) => m.clockSeconds === undefined)).toBe(true);
    expect(game.initialFen).toBe(DEFAULT_POSITION);
  });

  it.each(['1-0', '0-1', '1/2-1/2', '*'])('strips the trailing result token %s', (result) => {
    const game = parsePgn(`[Result "${result}"]\n\n1. e4 {[%clk 0:05:00]} 1... e5 {[%clk 0:04:59.5]} ${result}`);
    expect(game.moves).toHaveLength(2);
    expect(game.moves[1]).toMatchObject({ san: 'e5', clockSeconds: 299.5 });
    expect(game.headers.Result).toBe(result);
  });

  it('handles a result token directly after the last move without a comment', () => {
    const game = parsePgn('1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0');
    expect(game.moves).toHaveLength(7);
    expect(game.moves[6]?.san).toBe('Qxf7#');
  });

  it('accepts CRLF line endings', () => {
    const game = parsePgn('[White "a"]\r\n[Black "b"]\r\n\r\n1. d4 {[%clk 0:03:00]} 1... d5 {[%clk 0:02:59]} *\r\n');
    expect(game.headers.White).toBe('a');
    expect(game.moves).toHaveLength(2);
    expect(game.moves[0]?.clockSeconds).toBe(180);
  });

  it('uses the FEN header as initialFen and starts the move chain there', () => {
    const fen = '8/8/8/8/8/4k3/8/4K2R w K - 0 1';
    const game = parsePgn(`[SetUp "1"]\n[FEN "${fen}"]\n\n1. O-O Kd3 *`);
    expect(game.initialFen).toBe(fen);
    expect(game.moves[0]).toMatchObject({ san: 'O-O', uci: 'e1g1', fenBefore: fen });
    expect(game.moves[1]).toMatchObject({ san: 'Kd3', uci: 'e3d3' });
  });

  it('keeps the initial position for a game with no moves', () => {
    const game = parsePgn('[White "a"]\n[Black "b"]\n[Result "*"]\n\n*');
    expect(game.moves).toEqual([]);
    expect(game.initialFen).toBe(DEFAULT_POSITION);
    expect(game.headers.White).toBe('a');
  });

  it('parses clocks with hours', () => {
    const game = parsePgn('1. e4 {[%clk 1:30:00.5]} 1... e5 {[%clk 0:00:00.1]}');
    expect(game.moves[0]?.clockSeconds).toBe(5400.5);
    expect(game.moves[1]?.clockSeconds).toBe(0.1);
  });

  it('ignores comments that carry no clock', () => {
    const game = parsePgn('1. e4 {best by test} e5 {[%eval 0.3]}');
    expect(game.moves[0]?.clockSeconds).toBeUndefined();
    expect(game.moves[1]?.clockSeconds).toBeUndefined();
  });

  it('throws a descriptive error for an illegal move', () => {
    expect(() => parsePgn('1. e4 e5 2. Nf9 *')).toThrow(/Unable to parse PGN/);
  });

  it('throws a descriptive error for garbage input', () => {
    expect(() => parsePgn('this is not !! a pgn ??')).toThrow(/Unable to parse PGN/);
  });

  it('throws for empty input', () => {
    expect(() => parsePgn('')).toThrow(/empty/);
    expect(() => parsePgn('   \n ')).toThrow(/empty/);
  });
});

describe('parseClockSeconds', () => {
  it.each([
    ['[%clk 0:04:58.8]', 298.8],
    ['[%clk 0:04:35]', 275],
    ['[%clk 0:00:01]', 1],
    ['[%clk 1:00:00]', 3600],
    ['[%clk 4:58]', 298],
    ['[%clk 0:00:00.1]', 0.1],
    ['prefix [%clk 0:01:00] suffix', 60],
  ])('parses %s to %d seconds', (comment, seconds) => {
    expect(parseClockSeconds(comment)).toBe(seconds);
  });

  it('returns undefined without a clock tag', () => {
    expect(parseClockSeconds('')).toBeUndefined();
    expect(parseClockSeconds('[%eval 0.3]')).toBeUndefined();
    expect(parseClockSeconds('[%clk abc]')).toBeUndefined();
  });
});

describe('openingNameFromEcoUrl', () => {
  it.each([
    ['https://www.chess.com/openings/Modern-Defense-with-1-d4...3.Bf4-d6-4.e3-Nf6-5.Be2', 'Modern Defense with 1 d4'],
    ['https://www.chess.com/openings/Sicilian-Defense-Najdorf-Variation', 'Sicilian Defense Najdorf Variation'],
    ['https://www.chess.com/openings/Queens-Pawn-Opening-Accelerated-London-System-2...Nf6-3.e3', 'Queens Pawn Opening Accelerated London System'],
    ['https://www.chess.com/openings/Indian-Game-2.Bf4-d6-3.Nc3', 'Indian Game'],
    ['https://www.chess.com/openings/Pirc-Defense-Modern-Defense-Geller-System-2...Nf6', 'Pirc Defense Modern Defense Geller System'],
    ['https://www.chess.com/openings/Kings-Pawn-Opening-1.e4', 'Kings Pawn Opening'],
    ['https://www.chess.com/openings/Ruy-Lopez-Opening-Morphy-Defense-4.Ba4', 'Ruy Lopez Opening Morphy Defense'],
  ])('%s -> %s', (url, name) => {
    expect(openingNameFromEcoUrl(url)).toBe(name);
  });

  it('tolerates trailing slashes, query strings and fragments', () => {
    expect(openingNameFromEcoUrl('https://www.chess.com/openings/Sicilian-Defense/')).toBe('Sicilian Defense');
    expect(openingNameFromEcoUrl('https://www.chess.com/openings/Sicilian-Defense?x=1#top')).toBe('Sicilian Defense');
  });

  it('decodes percent-encoded slugs and collapses whitespace', () => {
    expect(openingNameFromEcoUrl('https://www.chess.com/openings/Kings%20Gambit--Accepted')).toBe('Kings Gambit Accepted');
  });

  it('returns an empty string for an empty url', () => {
    expect(openingNameFromEcoUrl('')).toBe('');
  });
});
