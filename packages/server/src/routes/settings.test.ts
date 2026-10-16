import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS } from '@chess-analyzer/core';
import type { App } from '../app.js';
import { createTestApp } from '../test/helpers.js';
import { DEFAULT_ANALYSIS_SETTINGS } from '../settings.js';

let app: App;

beforeEach(async () => {
  app = await createTestApp({ startQueue: false, config: { enginePath: 'engines/stockfish' } });
});

afterEach(async () => {
  await app.close();
});

describe('/api/settings', () => {
  it('returns documented defaults', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ analysis: DEFAULT_ANALYSIS_SETTINGS, thresholds: DEFAULT_THRESHOLDS });
    expect(res.json().analysis).toMatchObject({ depth: 18, multiPv: 3, threads: 8, hashMb: 512, enginePath: 'engines/stockfish' });
  });

  it('round-trips a partial update and persists it', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { analysis: { depth: 22, movetimeMs: 1500 }, thresholds: { bands: { mistake: 0.25 }, great: { excludeForcedMoves: false } } },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().analysis).toEqual({ ...DEFAULT_ANALYSIS_SETTINGS, depth: 22, movetimeMs: 1500 });
    expect(put.json().thresholds.bands).toEqual({ ...DEFAULT_THRESHOLDS.bands, mistake: 0.25 });
    expect(put.json().thresholds.great).toEqual({ ...DEFAULT_THRESHOLDS.great, excludeForcedMoves: false });
    expect(put.json().thresholds.brilliant).toEqual(DEFAULT_THRESHOLDS.brilliant);

    const get = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(get.json()).toEqual(put.json());

    // A second patch keeps earlier overrides; null clears movetime.
    const again = await app.inject({ method: 'PUT', url: '/api/settings', payload: { analysis: { threads: 4, movetimeMs: null } } });
    expect(again.json().analysis).toEqual({ ...DEFAULT_ANALYSIS_SETTINGS, depth: 22, threads: 4 });
    expect(again.json().thresholds.bands.mistake).toBe(0.25);

    const reset = await app.inject({ method: 'DELETE', url: '/api/settings' });
    expect(reset.json()).toEqual({ analysis: DEFAULT_ANALYSIS_SETTINGS, thresholds: DEFAULT_THRESHOLDS });
  });

  it('validates the body', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/api/settings', payload: { analysis: { depth: 'deep' } } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/analysis\.depth/);
    const unknown = await app.inject({ method: 'PUT', url: '/api/settings', payload: { analysis: { foo: 1 } } });
    expect(unknown.statusCode).toBe(400);
    const badThreshold = await app.inject({ method: 'PUT', url: '/api/settings', payload: { thresholds: { bands: { good: 5 } } } });
    expect(badThreshold.statusCode).toBe(400);
  });

  it('accepts the brilliant / great / miss threshold keys and rejects the removed maxEvalBeforeCp', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        thresholds: {
          brilliant: { maxWinProbBefore: 0.9 },
          great: { excludeRecaptures: false, excludeFreeCaptures: false },
          miss: { minOwnLoss: 0.2 },
        },
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().thresholds.brilliant).toEqual({ ...DEFAULT_THRESHOLDS.brilliant, maxWinProbBefore: 0.9 });
    expect(put.json().thresholds.great).toEqual({ ...DEFAULT_THRESHOLDS.great, excludeRecaptures: false, excludeFreeCaptures: false });
    expect(put.json().thresholds.miss.minOwnLoss).toBe(0.2);

    const removed = await app.inject({ method: 'PUT', url: '/api/settings', payload: { thresholds: { brilliant: { maxEvalBeforeCp: 300 } } } });
    expect(removed.statusCode).toBe(400);
    const outOfRange = await app.inject({ method: 'PUT', url: '/api/settings', payload: { thresholds: { brilliant: { maxWinProbBefore: 2 } } } });
    expect(outOfRange.statusCode).toBe(400);
  });

  it('drops stored overrides for threshold keys that no longer exist, so the settings page can save them back', async () => {
    app.ctx.settings.setRaw('thresholds', { brilliant: { maxEvalBeforeCp: 300, minSacrificeValue: 3 }, gone: { x: 1 } });
    const get = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(get.json().thresholds).toEqual({ ...DEFAULT_THRESHOLDS, brilliant: { ...DEFAULT_THRESHOLDS.brilliant, minSacrificeValue: 3 } });
    const saveBack = await app.inject({ method: 'PUT', url: '/api/settings', payload: { thresholds: get.json().thresholds } });
    expect(saveBack.statusCode).toBe(200);
  });
});

