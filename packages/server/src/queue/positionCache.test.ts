import { describe, expect, it } from 'vitest';
import type { PositionAnalysis } from '@chess-analyzer/core';
import { openDatabase } from '../db/index.js';
import { SqlitePositionCache } from './positionCache.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function analysis(cp: number, depth = 18): PositionAnalysis {
  return { fen: FEN, depth, multipv: 3, engine: 'Stockfish 19', lines: [{ multipv: 1, depth, score: { type: 'cp', value: cp }, pv: ['e2e4'] }] };
}

describe('SqlitePositionCache', () => {
  it('keys entries by movetime: a 200 ms search is not served as a depth-18 result and vice versa', async () => {
    const cache = new SqlitePositionCache(openDatabase(':memory:').db);
    await cache.set(analysis(20), 0);
    await cache.set(analysis(35), 200);

    expect((await cache.get(FEN, 18, 3, 'Stockfish 19', 0))?.lines[0]?.score).toEqual({ type: 'cp', value: 20 });
    expect((await cache.get(FEN, 18, 3, 'Stockfish 19', 200))?.lines[0]?.score).toEqual({ type: 'cp', value: 35 });
    expect(await cache.get(FEN, 18, 3, 'Stockfish 19', 500)).toBeUndefined();
    expect(cache.size()).toBe(2);
    // Omitting the movetime means a depth-limited search.
    expect((await cache.get(FEN, 18, 3, 'Stockfish 19'))?.lines[0]?.score).toEqual({ type: 'cp', value: 20 });
  });

  it('overwrites an entry with the same key', async () => {
    const cache = new SqlitePositionCache(openDatabase(':memory:').db);
    await cache.set(analysis(20), 200);
    await cache.set(analysis(25), 200);
    expect(cache.size()).toBe(1);
    expect((await cache.get(FEN, 18, 3, 'Stockfish 19', 200))?.lines[0]?.score).toEqual({ type: 'cp', value: 25 });
  });
});
