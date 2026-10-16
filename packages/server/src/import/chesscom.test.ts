import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../db/index.js';
import { games, profiles } from '../db/schema.js';
import {
  ChesscomClient,
  ChesscomError,
  archiveMonthIndex,
  importChesscomGames,
  monthIndexOfUnix,
  parsePgnHeaders,
  USER_AGENT,
} from './chesscom.js';
import { cloneGame, fakeOpeningNameFromEcoUrl, insertProfile, loadFixtureArchive, makeFakeChesscom } from '../test/helpers.js';

const OCT = 'https://api.chess.com/pub/player/xseven123/games/archives/2026/10';
const SEP = 'https://api.chess.com/pub/player/xseven123/games/archives/2026/09';
const AUG = 'https://api.chess.com/pub/player/xseven123/games/archives/2026/08';

function fixtureServer() {
  const fixture = loadFixtureArchive();
  const base = fixture[0] as (typeof fixture)[number];
  const octGames = [
    ...fixture,
    cloneGame(base, { uuid: 'daily-1', time_class: 'daily', end_time: base.end_time + 10 }),
    cloneGame(base, { uuid: 'variant-1', rules: 'chess960', end_time: base.end_time + 20 }),
  ];
  const sepGames = [
    cloneGame(base, { uuid: 'sep-1', end_time: 1_789_000_000 }),
    cloneGame(base, { uuid: 'sep-2', time_class: 'rapid', end_time: 1_789_000_100 }),
  ];
  const augGames = [cloneGame(base, { uuid: 'aug-1', time_class: 'bullet', end_time: 1_786_000_000 })];
  const server = makeFakeChesscom({ xseven123: { [AUG]: augGames, [SEP]: sepGames, [OCT]: octGames } });
  return { server, fixture, octGames, sepGames, augGames };
}

function setup() {
  const { server, ...rest } = fixtureServer();
  const database = openDatabase(':memory:');
  const client = new ChesscomClient({ fetch: server.fetch, retries: 1 });
  return { server, client, database, db: database.db, ...rest };
}

describe('helpers', () => {
  it('parses PGN headers and the ECOUrl', () => {
    const headers = parsePgnHeaders('[Event "Live Chess"]\n[ECO "B02"]\n[Result "1-0"]\n\n1. e4 1-0');
    expect(headers).toMatchObject({ Event: 'Live Chess', ECO: 'B02', Result: '1-0' });
  });

  it('computes archive month indexes', () => {
    expect(archiveMonthIndex(OCT)).toBe(2026 * 12 + 9);
    expect(archiveMonthIndex('https://x/y')).toBeUndefined();
    expect(monthIndexOfUnix(Date.UTC(2026, 9, 15) / 1000)).toBe(2026 * 12 + 9);
  });
});

describe('importChesscomGames', () => {
  it('imports every standard bullet/blitz/rapid game in "all" mode and counts skipped ones', async () => {
    const { db, client, server, fixture } = setup();
    const result = await importChesscomGames({
      db,
      username: 'XSeven123',
      mode: 'all',
      client,
      openingNameFromEcoUrl: fakeOpeningNameFromEcoUrl,
    });
    expect(result.imported).toBe(fixture.length + 3);
    expect(result.skipped).toBe(2);
    expect(result.archivesFetched).toBe(3);

    const rows = db.select().from(games).where(eq(games.profileUsername, 'xseven123')).all();
    expect(rows).toHaveLength(fixture.length + 3);
    expect(rows.map((r) => r.id)).not.toContain('daily-1');
    expect(rows.map((r) => r.id)).not.toContain('variant-1');

    const first = rows.find((r) => r.id === fixture[0]?.uuid);
    expect(first).toMatchObject({
      eco: 'B02',
      openingName: 'Alekhines Defense Maroczy Variation',
      result: '1-0',
      timeClass: 'blitz',
      whiteUsername: 'Sly_Sleepy_4',
      blackUsername: 'xSeven123',
      rated: true,
    });

    // lowercase username in every URL, User-Agent on every request
    for (const call of server.calls) {
      expect(call.url).not.toMatch(/XSeven123/);
      expect(call.headers['user-agent']).toBe(USER_AGENT);
    }
    const profile = db.select().from(profiles).where(eq(profiles.username, 'xseven123')).get();
    expect(profile?.lastSync).toBeTypeOf('number');
  });

  it('"latest N" walks from the newest archive and stops early', async () => {
    const { db, client, server } = setup();
    const result = await importChesscomGames({
      db,
      username: 'xseven123',
      mode: 'latest',
      count: 3,
      client,
      openingNameFromEcoUrl: fakeOpeningNameFromEcoUrl,
    });
    expect(result.imported).toBe(3);
    expect(result.archivesFetched).toBe(1);
    expect(server.calls.map((c) => c.url)).toContain(OCT);
    expect(server.calls.map((c) => c.url)).not.toContain(SEP);
    expect(server.calls.map((c) => c.url)).not.toContain(AUG);

    const rows = db.select().from(games).all().sort((a, b) => b.endTime - a.endTime);
    expect(rows).toHaveLength(3);
    // The newest three standard games of October, newest first.
    expect(result.gameIds).toEqual(rows.map((r) => r.id));
  });

  it('"latest N" spans archives when the newest one is too small', async () => {
    const { db, client, server } = setup();
    const result = await importChesscomGames({
      db,
      username: 'xseven123',
      mode: 'latest',
      count: 6,
      client,
      openingNameFromEcoUrl: fakeOpeningNameFromEcoUrl,
    });
    expect(result.imported).toBe(6);
    expect(result.archivesFetched).toBe(2);
    expect(server.calls.map((c) => c.url)).not.toContain(AUG);
  });

  it('resync in "all" mode only fetches months >= the last_sync month', async () => {
    const { db, client, server } = setup();
    insertProfile(db, 'xseven123', Math.floor(Date.UTC(2026, 8, 20) / 1000)); // September 2026
    const result = await importChesscomGames({
      db,
      username: 'xseven123',
      mode: 'all',
      client,
      openingNameFromEcoUrl: fakeOpeningNameFromEcoUrl,
    });
    const urls = server.calls.map((c) => c.url);
    expect(urls).toContain(SEP);
    expect(urls).toContain(OCT);
    expect(urls).not.toContain(AUG);
    expect(result.archivesFetched).toBe(2);
  });

  it('re-importing is idempotent (upsert by uuid)', async () => {
    const { db, client } = setup();
    const opts = { db, username: 'xseven123', mode: 'all' as const, client, openingNameFromEcoUrl: fakeOpeningNameFromEcoUrl };
    await importChesscomGames(opts);
    await importChesscomGames(opts);
    expect(db.select().from(games).all()).toHaveLength(8);
  });

  it('rejects unknown users with a clear error', async () => {
    const { db, client } = setup();
    await expect(importChesscomGames({ db, username: 'nobody-here', mode: 'all', client })).rejects.toMatchObject({
      name: 'ChesscomError',
      code: 'USER_NOT_FOUND',
      message: expect.stringContaining('nobody-here'),
    });
    await expect(client.getPlayer('nobody-here')).rejects.toBeInstanceOf(ChesscomError);
    expect(db.select().from(profiles).all()).toHaveLength(0);
  });

  it('reports progress and honours cancellation', async () => {
    const { db, client } = setup();
    const progress: number[] = [];
    const abort = new AbortController();
    await expect(
      importChesscomGames({
        db,
        username: 'xseven123',
        mode: 'all',
        client,
        signal: abort.signal,
        openingNameFromEcoUrl: fakeOpeningNameFromEcoUrl,
        onProgress: (p) => {
          progress.push(p.progress);
          abort.abort(new Error('stop now'));
        },
      }),
    ).rejects.toThrow('stop now');
    expect(progress).toEqual([1 / 3]);
  });
});
