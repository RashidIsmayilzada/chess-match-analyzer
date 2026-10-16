import { describe, expect, it } from 'vitest';
import { isWhitePly, moveNumber, parsePgnPlies, plyLabel, plyOffsetFromFen, sanLineToText, squareToGrid, START_FEN, turnFromFen } from './chess';

describe('ply offset for games starting from a FEN', () => {
  it('is 0 for the standard start position', () => {
    expect(plyOffsetFromFen(START_FEN)).toBe(0);
  });

  it('counts the plies already played: black to move at move 1 is 1, white at move 12 is 22', () => {
    expect(plyOffsetFromFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1')).toBe(1);
    expect(plyOffsetFromFen('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 12')).toBe(22);
    expect(plyOffsetFromFen('8/8/8/8/8/8/8/K6k b - - 0 40')).toBe(79);
  });

  it('labels, columns and move numbers shift with the offset', () => {
    expect(plyLabel(1)).toBe('1.');
    expect(plyLabel(2)).toBe('1...');
    expect(plyLabel(1, 1)).toBe('1...');
    expect(plyLabel(2, 1)).toBe('2.');
    expect(isWhitePly(1)).toBe(true);
    expect(isWhitePly(1, 1)).toBe(false);
    expect(moveNumber(3, 22)).toBe(13);
    expect(sanLineToText(['Nf3', 'Nf6', 'Nc3'], 2, 1)).toBe('2. Nf3 Nf6 3. Nc3');
    expect(sanLineToText(['Nc6', 'Nf3'], 1, 1)).toBe('1... Nc6 2. Nf3');
    expect(sanLineToText(['e4', 'e5'], 1)).toBe('1. e4 e5');
  });

  it('parsePgnPlies keeps game plies 1-based so analysis lookups stay aligned', () => {
    const pgn = '[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]\n\n1... Nc6 2. Nf3 Nf6 3. Nc3';
    const plies = parsePgnPlies(pgn);
    expect(plies.map((p) => [p.ply, p.color, p.san])).toEqual([
      [1, 'b', 'Nc6'],
      [2, 'w', 'Nf3'],
      [3, 'b', 'Nf6'],
      [4, 'w', 'Nc3'],
    ]);
    const offset = plyOffsetFromFen(plies[0]!.fenBefore);
    expect(offset).toBe(1);
    expect(plies.map((p) => plyLabel(p.ply, offset))).toEqual(['1...', '2.', '2...', '3.']);
    expect(turnFromFen(plies[0]!.fenBefore)).toBe('b');
  });
});

describe('squareToGrid', () => {
  it('maps squares to the top-left based grid for white orientation', () => {
    expect(squareToGrid('a8', 'w')).toEqual({ col: 0, row: 0 });
    expect(squareToGrid('h1', 'w')).toEqual({ col: 7, row: 7 });
    expect(squareToGrid('e4', 'w')).toEqual({ col: 4, row: 4 });
  });

  it('mirrors both axes for black orientation', () => {
    expect(squareToGrid('a8', 'b')).toEqual({ col: 7, row: 7 });
    expect(squareToGrid('h1', 'b')).toEqual({ col: 0, row: 0 });
    expect(squareToGrid('e4', 'b')).toEqual({ col: 3, row: 3 });
  });
});
