import { describe, expect, it } from 'vitest';

import { parseBestmoveLine, parseIdNameLine, parseInfoLine, sideToMove, toWhitePov } from './protocol.js';

describe('parseInfoLine', () => {
  it('parses a full Stockfish info line', () => {
    const info = parseInfoLine(
      'info depth 12 seldepth 18 multipv 2 score cp -35 nodes 123456 nps 1000000 hashfull 12 tbhits 0 time 123 pv e7e5 g1f3 b8c6',
    );
    expect(info).toBeDefined();
    expect(info!.depth).toBe(12);
    expect(info!.seldepth).toBe(18);
    expect(info!.multipv).toBe(2);
    expect(info!.score).toEqual({ type: 'cp', value: -35 });
    expect(info!.bound).toBe(false);
    expect(info!.nodes).toBe(123456);
    expect(info!.timeMs).toBe(123);
    expect(info!.pv).toEqual(['e7e5', 'g1f3', 'b8c6']);
  });

  it('parses mate scores and bound flags', () => {
    const mate = parseInfoLine('info depth 5 multipv 1 score mate -3 nodes 10 pv a1a8');
    expect(mate!.score).toEqual({ type: 'mate', value: -3 });
    expect(mate!.bound).toBe(false);

    const lower = parseInfoLine('info depth 20 multipv 1 score cp 50 lowerbound nodes 10 pv e2e4');
    expect(lower!.bound).toBe(true);
    expect(lower!.score).toEqual({ type: 'cp', value: 50 });

    const upper = parseInfoLine('info depth 20 multipv 1 score cp 50 upperbound nodes 10 pv e2e4');
    expect(upper!.bound).toBe(true);
  });

  it('handles an empty pv and wdl / currmove noise', () => {
    const empty = parseInfoLine('info depth 1 seldepth 0 multipv 1 score cp 0 nodes 0 nps 0 hashfull 0 tbhits 0 time 1 pv ');
    expect(empty!.pv).toEqual([]);
    expect(empty!.score).toEqual({ type: 'cp', value: 0 });

    const wdl = parseInfoLine('info depth 3 multipv 1 score cp 10 wdl 300 500 200 nodes 5 pv d2d4 d7d5');
    expect(wdl!.pv).toEqual(['d2d4', 'd7d5']);

    const curr = parseInfoLine('info depth 25 currmove e2e4 currmovenumber 1');
    expect(curr!.score).toBeUndefined();
    expect(curr!.pv).toEqual([]);
  });

  it('captures info string lines and ignores non-info lines', () => {
    const str = parseInfoLine('info string NNUE evaluation using nn.nnue enabled');
    expect(str!.string).toBe('NNUE evaluation using nn.nnue enabled');
    expect(parseInfoLine('bestmove e2e4')).toBeUndefined();
    expect(parseInfoLine('readyok')).toBeUndefined();
  });
});

describe('parseBestmoveLine', () => {
  it('returns the move, null for (none), undefined for other lines', () => {
    expect(parseBestmoveLine('bestmove e2e4 ponder e7e5')).toBe('e2e4');
    expect(parseBestmoveLine('bestmove e7e8q')).toBe('e7e8q');
    expect(parseBestmoveLine('bestmove (none)')).toBeNull();
    expect(parseBestmoveLine('info depth 1')).toBeUndefined();
  });
});

describe('parseIdNameLine', () => {
  it('extracts the engine name', () => {
    expect(parseIdNameLine('id name Stockfish 19')).toBe('Stockfish 19');
    expect(parseIdNameLine('id author the Stockfish developers')).toBeUndefined();
    expect(parseIdNameLine('uciok')).toBeUndefined();
  });
});

describe('sideToMove / toWhitePov', () => {
  it('reads the side to move from a FEN', () => {
    expect(sideToMove('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe('w');
    expect(sideToMove('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1')).toBe('b');
    expect(sideToMove('8/8/8/8/8/8/8/8')).toBe('w');
  });

  it('flips cp and mate values when black is to move', () => {
    expect(toWhitePov({ type: 'cp', value: 40 }, 'w')).toEqual({ type: 'cp', value: 40 });
    expect(toWhitePov({ type: 'cp', value: 40 }, 'b')).toEqual({ type: 'cp', value: -40 });
    expect(toWhitePov({ type: 'mate', value: 2 }, 'b')).toEqual({ type: 'mate', value: -2 });
    expect(toWhitePov({ type: 'mate', value: -1 }, 'b')).toEqual({ type: 'mate', value: 1 });
    expect(Object.is(toWhitePov({ type: 'cp', value: 0 }, 'b').value, 0)).toBe(true);
  });
});
