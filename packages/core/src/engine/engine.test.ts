/**
 * Integration tests against the real Stockfish binary in engines/stockfish.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Chess } from 'chess.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EngineProcessError, UciEngine } from './index.js';

const ENGINE_PATH = resolve(import.meta.dirname, '../../../../engines/stockfish');

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** White has no queen, black to move: black is up a queen. */
const BLACK_UP_QUEEN_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR b KQkq - 0 1';
/** White to move, Ra8#. */
const WHITE_MATE_IN_1_FEN = '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1';
/** Black to move, ...Ra1#. */
const BLACK_MATE_IN_1_FEN = 'r5k1/8/8/8/8/8/5PPP/6K1 b - - 0 1';
/** White is checkmated (Qg2#). */
const CHECKMATED_FEN = '8/8/8/8/8/5k2/6q1/7K w - - 0 1';
/** Black is stalemated. */
const STALEMATE_FEN = 'k7/2Q5/1K6/8/8/8/8/8 b - - 0 1';
/** Black has exactly one legal move (Kb8). */
const SINGLE_MOVE_FEN = 'k7/8/1K6/8/8/8/8/1R6 b - - 0 1';

function isLegal(fen: string, uci: string): boolean {
  const chess = new Chess(fen);
  return chess.moves({ verbose: true }).some((m) => m.lan === uci || m.from + m.to + (m.promotion ?? '') === uci);
}

describe.skipIf(!existsSync(ENGINE_PATH))('UciEngine (real Stockfish)', () => {
  let engine: UciEngine;

  beforeAll(async () => {
    engine = new UciEngine({ enginePath: ENGINE_PATH, threads: 1, hashMb: 16 });
    await engine.start();
  });

  afterAll(async () => {
    await engine.quit();
  });

  it('start() reports the engine name', () => {
    expect(engine.name).toBe('Stockfish 19');
    expect(engine.isRunning).toBe(true);
  });

  it('start position depth 10 multipv 3 returns three legal lines with a small white edge', async () => {
    const result = await engine.analyse(START_FEN, { depth: 10, multiPv: 3 });
    expect(result.fen).toBe(START_FEN);
    expect(result.engine).toBe('Stockfish 19');
    expect(result.multipv).toBe(3);
    expect(result.depth).toBe(10);
    expect(result.lines).toHaveLength(3);
    expect(result.lines.map((l) => l.multipv)).toEqual([1, 2, 3]);
    for (const line of result.lines) {
      expect(line.depth).toBe(10);
      expect(line.pv.length).toBeGreaterThan(0);
      expect(isLegal(START_FEN, line.pv[0]!)).toBe(true);
    }
    const best = result.lines[0]!;
    expect(best.score.type).toBe('cp');
    expect(best.score.value).toBeGreaterThanOrEqual(0);
    expect(best.score.value).toBeLessThan(100);
    // Lines are ordered best first (white POV, white to move => descending).
    expect(result.lines[1]!.score.value).toBeLessThanOrEqual(best.score.value);
    expect(result.lines[2]!.score.value).toBeLessThanOrEqual(result.lines[1]!.score.value);
  });

  it('normalises scores to white POV when black is to move', async () => {
    const result = await engine.analyse(BLACK_UP_QUEEN_FEN, { depth: 10, multiPv: 2 });
    expect(result.lines.length).toBeGreaterThanOrEqual(1);
    const best = result.lines[0]!;
    expect(best.score.type).toBe('cp');
    expect(best.score.value).toBeLessThan(-400);
    expect(isLegal(BLACK_UP_QUEEN_FEN, best.pv[0]!)).toBe(true);
    // Black to move: white POV scores ascend with multipv rank (line 2 is better for white).
    expect(result.lines[1]!.score.value).toBeGreaterThanOrEqual(best.score.value);
  });

  it('reports mate-in-1 with the correct sign for both colours', async () => {
    const white = await engine.analyse(WHITE_MATE_IN_1_FEN, { depth: 8, multiPv: 1 });
    expect(white.lines[0]!.score).toEqual({ type: 'mate', value: 1 });
    expect(white.lines[0]!.pv[0]).toBe('a1a8');

    const black = await engine.analyse(BLACK_MATE_IN_1_FEN, { depth: 8, multiPv: 1 });
    expect(black.lines[0]!.score).toEqual({ type: 'mate', value: -1 });
    expect(black.lines[0]!.pv[0]).toBe('a8a1');
  });

  it('returns no lines for a checkmated or stalemated position', async () => {
    const mated = await engine.analyse(CHECKMATED_FEN, { depth: 8, multiPv: 3 });
    expect(mated.lines).toEqual([]);
    expect(mated.depth).toBe(0);
    expect(mated.multipv).toBe(3);

    const stale = await engine.analyse(STALEMATE_FEN, { depth: 8, multiPv: 3 });
    expect(stale.lines).toEqual([]);
  });

  it('copes with MultiPV larger than the number of legal moves', async () => {
    const result = await engine.analyse(SINGLE_MOVE_FEN, { depth: 8, multiPv: 4 });
    expect(result.multipv).toBe(4);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.multipv).toBe(1);
    expect(result.lines[0]!.pv[0]).toBe('a8b8');
  });

  it('serialises concurrent analyse() calls and keeps results apart', async () => {
    const [a, b, c] = await Promise.all([
      engine.analyse(START_FEN, { depth: 6, multiPv: 1 }),
      engine.analyse(WHITE_MATE_IN_1_FEN, { depth: 6, multiPv: 2 }),
      engine.analyse(BLACK_UP_QUEEN_FEN, { depth: 6, multiPv: 1 }),
    ]);
    expect(a.fen).toBe(START_FEN);
    expect(a.lines).toHaveLength(1);
    expect(isLegal(START_FEN, a.lines[0]!.pv[0]!)).toBe(true);
    expect(b.fen).toBe(WHITE_MATE_IN_1_FEN);
    expect(b.lines[0]!.score).toEqual({ type: 'mate', value: 1 });
    expect(b.lines).toHaveLength(2);
    expect(c.fen).toBe(BLACK_UP_QUEEN_FEN);
    expect(c.lines[0]!.score.value).toBeLessThan(0);
  });

  it('honours movetime searches', async () => {
    const t0 = Date.now();
    const result = await engine.analyse(START_FEN, { depth: 99, multiPv: 1, movetimeMs: 200 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(3_000);
    expect(result.lines).toHaveLength(1);
    expect(result.depth).toBeGreaterThan(0);
  });

  it('stop() interrupts a deep search quickly and returns the best result so far', async () => {
    const t0 = Date.now();
    const pending = engine.analyse(START_FEN, { depth: 30, multiPv: 2 });
    // Give the engine a moment to start producing lines, then interrupt.
    await new Promise((r) => setTimeout(r, 300));
    engine.stop();
    const result = await pending;
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(3_000);
    expect(result.lines.length).toBeGreaterThanOrEqual(1);
    expect(result.depth).toBeGreaterThan(0);
    expect(result.depth).toBeLessThan(30);
    expect(isLegal(START_FEN, result.lines[0]!.pv[0]!)).toBe(true);
    // The engine is still usable afterwards.
    const next = await engine.analyse(START_FEN, { depth: 5, multiPv: 1 });
    expect(next.lines).toHaveLength(1);
  });

  it('stop() is a no-op when idle', () => {
    expect(() => engine.stop()).not.toThrow();
  });

  it('setOptions() changes Threads / Hash between searches', async () => {
    await engine.setOptions({ threads: 2, hashMb: 32 });
    const result = await engine.analyse(START_FEN, { depth: 6, multiPv: 1 });
    expect(result.lines).toHaveLength(1);
    await engine.setOptions({ threads: 1, hashMb: 16 });
  });
});

describe.skipIf(!existsSync(ENGINE_PATH))('UciEngine lifecycle', () => {
  it('quit() terminates the process and later calls reject', async () => {
    const engine = new UciEngine({ enginePath: ENGINE_PATH });
    await engine.start();
    expect(engine.isRunning).toBe(true);
    await engine.quit();
    expect(engine.isRunning).toBe(false);
    await expect(engine.analyse(START_FEN, { depth: 4, multiPv: 1 })).rejects.toBeInstanceOf(EngineProcessError);
    await expect(engine.quit()).resolves.toBeUndefined();
  });

  it('quit() during a search resolves the pending analyse() with the best result so far', async () => {
    const engine = new UciEngine({ enginePath: ENGINE_PATH });
    await engine.start();
    const pending = engine.analyse(START_FEN, { depth: 40, multiPv: 1 });
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await engine.quit();
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(engine.isRunning).toBe(false);
    const result = await pending;
    expect(result.lines.length).toBeGreaterThanOrEqual(1);
    expect(result.depth).toBeLessThan(40);
    await expect(engine.analyse(START_FEN, { depth: 4, multiPv: 1 })).rejects.toBeInstanceOf(EngineProcessError);
  });

  it('an externally killed process rejects the pending analyse() and later calls', async () => {
    const lines: string[] = [];
    const engine = new UciEngine({ enginePath: ENGINE_PATH, onLine: (l) => lines.push(l) });
    await engine.start();
    const pending = engine.analyse(START_FEN, { depth: 40, multiPv: 1 });
    await new Promise((r) => setTimeout(r, 100));
    // Reach into the process the same way an OOM-killer would.
    (engine as unknown as { proc: { kill(sig: string): void } }).proc.kill('SIGKILL');
    await expect(pending).rejects.toBeInstanceOf(EngineProcessError);
    await expect(pending).rejects.toThrow(/SIGKILL/);
    expect(engine.isRunning).toBe(false);
    await expect(engine.analyse(START_FEN, { depth: 4, multiPv: 1 })).rejects.toBeInstanceOf(EngineProcessError);
    await expect(engine.quit()).resolves.toBeUndefined();
  });

  it('analyse() before start() rejects', async () => {
    const engine = new UciEngine({ enginePath: ENGINE_PATH });
    await expect(engine.analyse(START_FEN, { depth: 4, multiPv: 1 })).rejects.toThrow(/not started/);
  });

  it('start() rejects when the binary does not exist', async () => {
    const engine = new UciEngine({ enginePath: '/nonexistent/stockfish-binary' });
    await expect(engine.start()).rejects.toBeInstanceOf(EngineProcessError);
    await expect(engine.quit()).resolves.toBeUndefined();
  });

  it('forwards raw lines to onLine', async () => {
    const lines: string[] = [];
    const engine = new UciEngine({ enginePath: ENGINE_PATH, onLine: (l) => lines.push(l) });
    await engine.start();
    await engine.quit();
    expect(lines).toContain('uciok');
    expect(lines).toContain('readyok');
  });
});
