import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameRecord, Profile } from '@chess-analyzer/core';
import type { App } from '../app.js';
import { gameAnalyses } from '../db/schema.js';
import { createTestApp, fakeSettingsKey, insertGame, linkGame } from '../test/helpers.js';

let app: App;

beforeEach(async () => {
  app = await createTestApp({ startQueue: false });
  const db = app.ctx.database.db;
  for (let i = 0; i < 12; i++) {
    insertGame(db, {
      id: `alice-${i}`,
      profileUsername: 'alice',
      timeClass: i % 3 === 0 ? 'rapid' : 'blitz',
      endTime: 1_700_000_000 + i * 1000,
    });
  }
  for (let i = 0; i < 3; i++) {
    insertGame(db, { id: `bob-${i}`, profileUsername: 'bob', timeClass: 'bullet', endTime: 1_600_000_000 + i });
  }
});

afterEach(async () => {
  await app.close();
});

async function list(query: string): Promise<{ items: GameRecord[]; total: number }> {
  const res = await app.inject({ method: 'GET', url: `/api/games${query}` });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('GET /api/games', () => {
  it('lists newest first with total and default page size', async () => {
    const body = await list('');
    expect(body.total).toBe(15);
    expect(body.items).toHaveLength(15);
    expect(body.items[0]?.id).toBe('alice-11');
    expect(body.items[0]).toMatchObject({ analyzed: false, white: { username: 'alice', rating: 1500 }, result: '1-0', eco: 'C20' });
  });

  it('filters by profile (case-insensitive) and time class', async () => {
    expect((await list('?profile=Alice')).total).toBe(12);
    expect((await list('?profile=bob')).total).toBe(3);
    expect((await list('?profile=alice&timeClass=rapid')).total).toBe(4);
    expect((await list('?timeClass=bullet')).items.every((g) => g.timeClass === 'bullet')).toBe(true);
    expect((await list('?profile=nobody')).total).toBe(0);
  });

  it('paginates', async () => {
    const page1 = await list('?profile=alice&page=1&pageSize=5');
    const page2 = await list('?profile=alice&page=2&pageSize=5');
    const page3 = await list('?profile=alice&page=3&pageSize=5');
    expect(page1.total).toBe(12);
    expect(page1.items.map((g) => g.id)).toEqual(['alice-11', 'alice-10', 'alice-9', 'alice-8', 'alice-7']);
    expect(page2.items.map((g) => g.id)).toEqual(['alice-6', 'alice-5', 'alice-4', 'alice-3', 'alice-2']);
    expect(page3.items.map((g) => g.id)).toEqual(['alice-1', 'alice-0']);
  });

  it('rejects invalid query values', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/games?timeClass=daily' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/timeClass/);
    expect((await app.inject({ method: 'GET', url: '/api/games?pageSize=0' })).statusCode).toBe(400);
  });

  it('filters by analyzed using the current settings key', async () => {
    const db = app.ctx.database.db;
    const settings = app.ctx.settings.getAnalysis();
    // Pretend the engine ran once so the settings key is known.
    app.ctx.settings.rememberEngineName(app.ctx.config.repoRoot + '/' + settings.enginePath, 'FakeFish 1');
    const key = fakeSettingsKey(settings, 'FakeFish 1');
    const analysisJson = JSON.stringify({ white: { accuracy: 91.5 }, black: { accuracy: 77.25 } });
    db.insert(gameAnalyses)
      .values({ gameId: 'alice-3', settingsKey: key, analysisJson, analyzedAt: new Date().toISOString() })
      .run();
    db.insert(gameAnalyses)
      .values({ gameId: 'alice-4', settingsKey: 'other-key', analysisJson: '{}', analyzedAt: new Date().toISOString() })
      .run();

    const analyzed = await list('?analyzed=true');
    expect(analyzed.items.map((g) => g.id)).toEqual(['alice-3']);
    // Analysed rows carry the per-player accuracy so the games table needs no extra requests.
    expect(analyzed.items[0]?.accuracy).toEqual({ white: 91.5, black: 77.25 });
    const all = await list('');
    expect(all.items.find((g) => g.id === 'alice-4')?.accuracy).toBeUndefined();
    expect(all.items.find((g) => g.id === 'alice-3')?.accuracy).toEqual({ white: 91.5, black: 77.25 });
    const unanalyzed = await list('?analyzed=false');
    expect(unanalyzed.total).toBe(14);
    expect(unanalyzed.items.find((g) => g.id === 'alice-4')?.analyzed).toBe(false);
  });
});

describe('GET /api/games/:id and /api/profiles', () => {
  it('returns a game without analysis', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/games/bob-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ game: { id: 'bob-1', analyzed: false } });
    expect(res.json().analysis).toBeUndefined();
  });

  it('404s for unknown games', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/games/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/not found/i);
  });

  it('a game linked to two profiles is listed and counted for both and viewed from each side', async () => {
    const db = app.ctx.database.db;
    // alice (white, owner) played bob (black); bob imported the same game later.
    insertGame(db, { id: 'shared', profileUsername: 'alice', whiteUsername: 'alice', blackUsername: 'bob' });
    linkGame(db, 'shared', 'bob');

    expect((await list('?profile=alice')).total).toBe(13);
    const forBob = await list('?profile=bob');
    expect(forBob.total).toBe(4);
    expect(forBob.items.find((g) => g.id === 'shared')?.profileUsername).toBe('bob');
    expect((await list('')).items.find((g) => g.id === 'shared')?.profileUsername).toBe('alice');

    const asBob = (await app.inject({ method: 'GET', url: '/api/games/shared?profile=bob' })).json() as { game: GameRecord };
    expect(asBob.game.profileUsername).toBe('bob');
    const asOwner = (await app.inject({ method: 'GET', url: '/api/games/shared' })).json() as { game: GameRecord };
    expect(asOwner.game.profileUsername).toBe('alice');
    // Not linked: the owner is reported.
    const asStranger = (await app.inject({ method: 'GET', url: '/api/games/shared?profile=carol' })).json() as { game: GameRecord };
    expect(asStranger.game.profileUsername).toBe('alice');

    const profiles = (await app.inject({ method: 'GET', url: '/api/profiles' })).json() as Profile[];
    expect(profiles).toEqual([
      { username: 'alice', gameCount: 13 },
      { username: 'bob', gameCount: 4 },
    ]);
    expect(app.ctx.games.profilesOf('shared')).toEqual(['alice', 'bob']);
    expect(app.ctx.games.latestGameIds('bob', 1)).toEqual(['shared']);
  });

  it('lists profiles with game counts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/profiles' });
    expect(res.statusCode).toBe(200);
    const profiles = res.json() as Profile[];
    expect(profiles).toEqual([
      { username: 'alice', gameCount: 12 },
      { username: 'bob', gameCount: 3 },
    ]);
  });
});
