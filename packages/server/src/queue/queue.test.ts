import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnalysisJob, AnalyzeGameOptions, GameAnalysis, ImportJob } from '@chess-analyzer/core';
import type { App } from '../app.js';
import { jobs } from '../db/schema.js';
import {
  FakeEngine,
  createTestApp,
  fakeAnalyzeGame,
  fakeGameAnalysis,
  insertGame,
  loadFixtureArchive,
  makeFakeChesscom,
  waitFor,
} from '../test/helpers.js';
import { JobStore } from './jobs.js';

let app: App | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function getJob(id: string): Promise<AnalysisJob | undefined> {
  const res = await app!.inject({ method: 'GET', url: '/api/jobs' });
  return (res.json() as AnalysisJob[]).find((j) => j.id === id);
}

async function waitForStatus(id: string, status: AnalysisJob['status']): Promise<AnalysisJob> {
  return waitFor(() => {
    const row = app!.ctx.queue.getAnalysisJob(id);
    return row?.status === status ? row : undefined;
  });
}

describe('analysis jobs', () => {
  beforeEach(async () => {
    app = await createTestApp();
    insertGame(app.ctx.database.db, { id: 'g1', profileUsername: 'alice' });
    insertGame(app.ctx.database.db, { id: 'g2', profileUsername: 'alice' });
  });

  it('runs an analysis job to completion and stores the analysis', async () => {
    const events: { event: string; data: unknown }[] = [];
    const original = app!.ctx.events.broadcast.bind(app!.ctx.events);
    app!.ctx.events.broadcast = (event, data) => {
      events.push({ event, data });
      original(event, data);
    };

    const res = await app!.inject({ method: 'POST', url: '/api/games/g1/analyze' });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };

    const done = await waitForStatus(jobId, 'done');
    expect(done).toMatchObject({ gameId: 'g1', progress: 1 });
    expect(done.startedAt).toBeTypeOf('string');
    expect(done.finishedAt).toBeTypeOf('string');
    expect(await getJob(jobId)).toMatchObject({ status: 'done' });

    const game = await app!.inject({ method: 'GET', url: '/api/games/g1' });
    const body = game.json() as { game: { analyzed: boolean }; analysis?: GameAnalysis };
    expect(body.game.analyzed).toBe(true);
    expect(body.analysis?.gameId).toBe('g1');
    expect(body.analysis?.settingsKey).toContain('FakeFish 1');

    expect((await app!.inject({ method: 'GET', url: '/api/games?analyzed=true' })).json().total).toBe(1);

    // Engine started once, position cache populated.
    expect(FakeEngine.created).toHaveLength(1);
    expect(FakeEngine.created[0]?.started).toBe(true);
    expect(FakeEngine.created[0]?.opts.threads).toBe(8);
    expect(app!.ctx.queue.cache.size()).toBe(1);

    const names = events.map((e) => e.event);
    expect(names).toContain('job-updated');
    expect(names).toContain('analysis-progress');
    const progress = events.filter((e) => e.event === 'analysis-progress').map((e) => (e.data as { progress: number }).progress);
    expect(progress.at(-1)).toBe(1);
  });

  it('dedupes active jobs for the same game and processes a batch sequentially', async () => {
    const first = (await app!.inject({ method: 'POST', url: '/api/games/g1/analyze' })).json() as { jobId: string };
    const second = (await app!.inject({ method: 'POST', url: '/api/games/g1/analyze' })).json() as { jobId: string };
    expect(second.jobId).toBe(first.jobId);

    const batch = await app!.inject({ method: 'POST', url: '/api/analyze/batch', payload: { gameIds: ['g1', 'g2'] } });
    expect(batch.statusCode).toBe(202);
    const { jobIds } = batch.json() as { jobIds: string[] };
    expect(jobIds[0]).toBe(first.jobId);
    expect(jobIds[1]).not.toBe(first.jobId);

    await waitForStatus(jobIds[1] as string, 'done');
    const all = (await app!.inject({ method: 'GET', url: '/api/jobs' })).json() as AnalysisJob[];
    expect(all).toHaveLength(2);
    expect(all.every((j) => j.status === 'done')).toBe(true);
    expect((await app!.inject({ method: 'GET', url: '/api/jobs?status=done' })).json()).toHaveLength(2);
    expect((await app!.inject({ method: 'GET', url: '/api/jobs?status=queued' })).json()).toHaveLength(0);
    // Only one engine process for both jobs.
    expect(FakeEngine.created).toHaveLength(1);

    const unknown = await app!.inject({ method: 'POST', url: '/api/analyze/batch', payload: { gameIds: ['nope'] } });
    expect(unknown.statusCode).toBe(404);
  });

  it('cancels a running job and stops the engine search', async () => {
    await app!.close();
    app = await createTestApp({ deps: { analyzeGame: fakeAnalyzeGame({ steps: 100, stepMs: 20 }) } });
    insertGame(app.ctx.database.db, { id: 'slow', profileUsername: 'alice' });

    const { jobId } = (await app.inject({ method: 'POST', url: '/api/games/slow/analyze' })).json() as { jobId: string };
    await waitForStatus(jobId, 'running');
    const del = await app.inject({ method: 'DELETE', url: `/api/jobs/${jobId}` });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ id: jobId, cancelled: true });

    const cancelled = await waitForStatus(jobId, 'cancelled');
    expect(cancelled.finishedAt).toBeTypeOf('string');
    expect(FakeEngine.created[0]?.stops).toBeGreaterThanOrEqual(1);
    expect((await app.inject({ method: 'GET', url: '/api/games/slow' })).json().game.analyzed).toBe(false);
  });

  it('cancels a queued job without running it', async () => {
    await app!.close();
    app = await createTestApp({ startQueue: false });
    insertGame(app.ctx.database.db, { id: 'q1', profileUsername: 'alice' });
    const { jobId } = (await app.inject({ method: 'POST', url: '/api/games/q1/analyze' })).json() as { jobId: string };
    expect(app.ctx.queue.getAnalysisJob(jobId)?.status).toBe('queued');
    expect(app.ctx.queue.cancel(jobId)).toBe(true);
    expect(app.ctx.queue.getAnalysisJob(jobId)?.status).toBe('cancelled');
    expect(app.ctx.queue.cancel(jobId)).toBe(false);
    expect((await app.inject({ method: 'DELETE', url: '/api/jobs/missing' })).statusCode).toBe(404);
  });

  it('marks a failing job as failed with the error message', async () => {
    await app!.close();
    app = await createTestApp({
      deps: {
        analyzeGame: async () => {
          throw new Error('engine exploded');
        },
      },
    });
    insertGame(app.ctx.database.db, { id: 'bad', profileUsername: 'alice' });
    const { jobId } = (await app.inject({ method: 'POST', url: '/api/games/bad/analyze' })).json() as { jobId: string };
    const failed = await waitForStatus(jobId, 'failed');
    expect(failed.error).toBe('engine exploded');
    // Engine is recycled after a failure.
    expect(FakeEngine.created[0]?.quit).toBe(true);
  });

  it('restarts the engine when enginePath/threads/hash change', async () => {
    const run = async (gameId: string) => {
      const { jobId } = (await app!.inject({ method: 'POST', url: `/api/games/${gameId}/analyze` })).json() as { jobId: string };
      await waitForStatus(jobId, 'done');
    };
    await run('g1');
    expect(FakeEngine.created).toHaveLength(1);

    await app!.inject({ method: 'PUT', url: '/api/settings', payload: { analysis: { depth: 12 } } });
    await run('g2');
    expect(FakeEngine.created).toHaveLength(1); // depth change does not restart

    await app!.inject({ method: 'PUT', url: '/api/settings', payload: { analysis: { threads: 2 } } });
    await run('g1');
    expect(FakeEngine.created).toHaveLength(2);
    expect(FakeEngine.created[0]?.quit).toBe(true);
    expect(FakeEngine.created[1]?.opts.threads).toBe(2);
  });

  it('a settings change plus GET /api/health does not restart the engine under a running job', async () => {
    await app!.close();
    app = await createTestApp({ deps: { analyzeGame: fakeAnalyzeGame({ steps: 30, stepMs: 20 }) } });
    insertGame(app.ctx.database.db, { id: 'busy', profileUsername: 'alice' });
    insertGame(app.ctx.database.db, { id: 'next', profileUsername: 'alice' });

    const { jobId } = (await app.inject({ method: 'POST', url: '/api/games/busy/analyze' })).json() as { jobId: string };
    await waitForStatus(jobId, 'running');
    await waitFor(() => FakeEngine.created.length === 1 && FakeEngine.created[0]?.started);

    await app.inject({ method: 'PUT', url: '/api/settings', payload: { analysis: { threads: 4 } } });
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, engine: 'FakeFish 1', queueIdle: false, engineRestartPending: true });

    // Still the same engine, still running, and the job finishes normally.
    expect(FakeEngine.created).toHaveLength(1);
    expect(FakeEngine.created[0]?.quit).toBe(false);
    expect(app.ctx.queue.getAnalysisJob(jobId)?.status).toBe('running');
    const done = await waitForStatus(jobId, 'done');
    expect(done.error).toBeUndefined();
    expect(FakeEngine.created[0]?.quit).toBe(false);

    // The next job picks up the new settings.
    const next = (await app.inject({ method: 'POST', url: '/api/games/next/analyze' })).json() as { jobId: string };
    await waitForStatus(next.jobId, 'done');
    expect(FakeEngine.created).toHaveLength(2);
    expect(FakeEngine.created[0]?.quit).toBe(true);
    expect(FakeEngine.created[1]?.opts.threads).toBe(4);
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({ engineRestartPending: false });
  });

  it('re-queues jobs left running by a previous process', async () => {
    await app!.close();
    app = await createTestApp({ startQueue: false });
    insertGame(app.ctx.database.db, { id: 'r1', profileUsername: 'alice' });
    const store = new JobStore(app.ctx.database.db);
    const row = store.insert('analysis', { gameId: 'r1' });
    app.ctx.database.db.update(jobs).set({ status: 'running', progress: 0.5 }).run();
    expect(store.get(row.id)?.status).toBe('running');

    app.ctx.queue.start();
    const done = await waitForStatus(row.id, 'done');
    expect(done.progress).toBe(1);
  });

  it('exposes the engine name on /api/health', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, engine: 'FakeFish 1' });
  });
});

describe('import jobs', () => {
  it('imports via the API, reports progress and auto-analyzes the latest games', async () => {
    const fixture = loadFixtureArchive();
    const archive = 'https://api.chess.com/pub/player/xseven123/games/archives/2026/10';
    const server = makeFakeChesscom({ xseven123: { [archive]: fixture } });
    const analyzed: string[] = [];
    app = await createTestApp({
      deps: {
        fetch: server.fetch,
        analyzeGame: async (opts: AnalyzeGameOptions) => {
          analyzed.push(opts.gameId);
          return fakeGameAnalysis(opts, 'FakeFish 1');
        },
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/import',
      payload: { username: 'XSeven123', mode: 'latest', count: 4, autoAnalyzeLatest: 2 },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };

    const job = await waitFor(() => {
      const j = app!.ctx.queue.getImportJob(jobId);
      return j?.status === 'done' ? j : undefined;
    });
    expect(job).toMatchObject<Partial<ImportJob>>({ username: 'xseven123', mode: 'latest', count: 4, imported: 4, skipped: 0, progress: 1 });
    const viaApi = (await app.inject({ method: 'GET', url: `/api/import/${jobId}` })).json() as ImportJob;
    expect(viaApi).toEqual(job);

    await waitFor(() => analyzed.length === 2);
    const games = (await app.inject({ method: 'GET', url: '/api/games?profile=xseven123' })).json() as { items: { id: string }[]; total: number };
    expect(games.total).toBe(4);
    expect(analyzed.sort()).toEqual(games.items.slice(0, 2).map((g) => g.id).sort());

    const profiles = (await app.inject({ method: 'GET', url: '/api/profiles' })).json() as { username: string; gameCount: number }[];
    expect(profiles).toMatchObject([{ username: 'xseven123', gameCount: 4 }]);
  });

  it('fails the job for an unknown user', async () => {
    const server = makeFakeChesscom({});
    app = await createTestApp({ deps: { fetch: server.fetch } });
    const { jobId } = (await app.inject({ method: 'POST', url: '/api/import', payload: { username: 'ghost', mode: 'all' } })).json() as { jobId: string };
    const job = await waitFor(() => {
      const j = app!.ctx.queue.getImportJob(jobId);
      return j?.status === 'failed' ? j : undefined;
    });
    expect(job.error).toMatch(/ghost.*not found/);
    expect((await app.inject({ method: 'GET', url: '/api/import/nope' })).statusCode).toBe(404);
  });

  it('validates the import body', async () => {
    app = await createTestApp({ startQueue: false });
    const res = await app.inject({ method: 'POST', url: '/api/import', payload: { username: '', mode: 'weird' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/username/);
  });
});
