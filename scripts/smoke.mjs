// Smoke-test driver used by scripts/smoke.sh. Talks to a running server over HTTP.
//   node scripts/smoke.mjs http://localhost:3001 [username]
import { parsePgn } from '@chess-analyzer/core';

const BASE = process.argv[2] ?? 'http://localhost:3001';
const USERNAME = process.argv[3] ?? 'xseven123';
const DEPTH = Number(process.env.SMOKE_DEPTH ?? 12);
const IMPORT_COUNT = 3;
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
const CACHED_RERUN_MAX_MS = 5000;

let failures = 0;
function check(cond, label, detail = '') {
  const ok = Boolean(cond);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
  return ok;
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fetchStatus, timeoutMs = JOB_TIMEOUT_MS) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await fetchStatus();
    if (last && ['done', 'failed', 'cancelled'].includes(last.status)) return { job: last, ms: Date.now() - start };
    await sleep(500);
  }
  throw new Error(`${label}: timed out after ${timeoutMs} ms (last status: ${last?.status})`);
}

/** Paths of every null / non-finite number in a JSON-serialisable value. */
function badNumericPaths(value, path = '$', out = []) {
  if (value === null || value === undefined) out.push(path);
  else if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(path);
  } else if (Array.isArray(value)) value.forEach((v, i) => badNumericPaths(v, `${path}[${i}]`, out));
  else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) badNumericPaths(v, `${path}.${k}`, out);
  return out;
}

async function main() {
  console.log(`smoke: ${BASE}, user ${USERNAME}, depth ${DEPTH}`);

  // Health + engine name.
  const health = await api('GET', '/health');
  check(health.ok === true, 'health ok', JSON.stringify(health));
  check(typeof health.engine === 'string' && health.engine.includes('Stockfish 19'), 'engine is Stockfish 19', health.engine);

  // Settings: shallow depth for speed.
  const settings = await api('PUT', '/settings', { analysis: { depth: DEPTH } });
  check(settings.analysis?.depth === DEPTH, `settings depth = ${DEPTH}`);

  // Openings search.
  const london = await api('GET', '/openings?q=london');
  check(Array.isArray(london) && london.length > 0, 'GET /openings?q=london returns results', `${london.length} lines, first: ${london[0]?.eco} ${london[0]?.name}`);

  // Import 3 latest games from chess.com.
  const { jobId: importJobId } = await api('POST', '/import', { username: USERNAME, mode: 'latest', count: IMPORT_COUNT });
  check(typeof importJobId === 'string', 'POST /import returns jobId', importJobId);
  const { job: importJob, ms: importMs } = await waitFor('import', () => api('GET', `/import/${importJobId}`));
  check(importJob.status === 'done', 'import job done', `${importJob.status} in ${importMs} ms, imported ${importJob.imported}, skipped ${importJob.skipped}${importJob.error ? `, error: ${importJob.error}` : ''}`);

  const games = await api('GET', `/games?profile=${encodeURIComponent(USERNAME)}`);
  check(games.items?.length === IMPORT_COUNT && games.total === IMPORT_COUNT, `GET /games -> ${IMPORT_COUNT} games`, `items ${games.items?.length}, total ${games.total}`);
  const game = games.items?.[0];
  if (!game) throw new Error('no games imported');
  console.log(`game: ${game.id} ${game.white.username} (${game.white.rating}) vs ${game.black.username} (${game.black.rating}) ${game.timeClass} ${game.result} ${game.url}`);

  // Analyse the first game.
  const { jobId } = await api('POST', `/games/${game.id}/analyze`);
  check(typeof jobId === 'string', 'POST /games/:id/analyze returns jobId', jobId);
  const findJob = async () => (await api('GET', '/jobs')).find((j) => j.id === jobId);
  const { job, ms: analyzeMs } = await waitFor('analysis', findJob);
  check(job.status === 'done', 'analysis job done', `${job.status} in ${(analyzeMs / 1000).toFixed(1)} s${job.error ? `, error: ${job.error}` : ''}`);

  const detail = await api('GET', `/games/${game.id}`);
  const analysis = detail.analysis;
  check(analysis !== undefined, 'GET /games/:id has analysis');
  check(detail.game.analyzed === true, 'game.analyzed is true');
  check(detail.game.accuracy && Number.isFinite(detail.game.accuracy.white), 'game.accuracy present on GameRecord', JSON.stringify(detail.game.accuracy));
  if (!analysis) throw new Error('no analysis');

  const parsed = parsePgn(game.pgn);
  check(analysis.moves.length === parsed.moves.length, 'analysis.moves.length == PGN move count', `${analysis.moves.length} vs ${parsed.moves.length}`);
  const classifications = new Set(['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder']);
  check(analysis.moves.every((m) => classifications.has(m.classification)), 'every move has a classification');
  const bookPlies = analysis.moves.filter((m) => m.classification === 'book').length;
  check(bookPlies > 0 && analysis.moves[0].classification === 'book', 'book moves at the start', `${bookPlies} book plies, lastBookPly ${analysis.opening.lastBookPly}`);
  const firstNonBook = analysis.moves.findIndex((m) => m.classification !== 'book');
  check(firstNonBook === -1 || analysis.moves.slice(firstNonBook).every((m) => m.classification !== 'book'), 'no book move after the first non-book move');
  check(analysis.opening.name && analysis.opening.name !== 'Unknown', 'opening name known', `${analysis.opening.eco} ${analysis.opening.name}`);
  for (const side of ['white', 'black']) {
    const p = analysis[side];
    check(p.accuracy >= 0 && p.accuracy <= 100, `${side} accuracy in 0..100`, p.accuracy.toFixed(1));
    check(p.estimatedRating >= 100 && p.estimatedRating <= 3200, `${side} estimatedRating sane`, `${p.estimatedRating} (avg cp loss ${p.averageCpLoss.toFixed(1)}, actual ${p.rating ?? '?'})`);
    const total = Object.values(p.counts).reduce((a, b) => a + b, 0);
    check(total === analysis.moves.filter((m) => m.color === side[0]).length, `${side} counts add up`, JSON.stringify(p.counts));
  }
  check(analysis.keyMoments.length > 0, 'keyMoments non-empty', analysis.keyMoments.join(','));
  const bad = badNumericPaths(analysis);
  check(bad.length === 0, 'no null / NaN anywhere in the analysis JSON', bad.slice(0, 5).join(' '));
  check(analysis.moves.every((m) => m.bestMove.uci && m.bestMove.san), 'every move has a best move');
  check(analysis.moves.every((m) => m.position.lines.length > 0), 'every position has engine lines');
  const forced = analysis.moves.filter((m) => m.position.lines.length === 1 && m.position.lines[0].pv[0] === m.uci);
  console.log(`info: ${forced.length} forced-move positions, ${analysis.moves.filter((m) => m.isSacrifice).length} sacrifices flagged`);

  // Re-run: must be served from the position cache.
  const { jobId: jobId2 } = await api('POST', `/games/${game.id}/analyze`);
  const { job: job2, ms: rerunMs } = await waitFor('re-analysis', async () => (await api('GET', '/jobs')).find((j) => j.id === jobId2));
  check(job2.status === 'done' && rerunMs < CACHED_RERUN_MAX_MS, 'repeat analysis finishes near-instantly from cache', `${rerunMs} ms (first run ${(analyzeMs / 1000).toFixed(1)} s)`);

  console.log('\n=== summary');
  console.log(JSON.stringify({
    game: game.url,
    moves: analysis.moves.length,
    opening: analysis.opening,
    white: { accuracy: analysis.white.accuracy, estimatedRating: analysis.white.estimatedRating, counts: analysis.white.counts },
    black: { accuracy: analysis.black.accuracy, estimatedRating: analysis.black.estimatedRating, counts: analysis.black.counts },
    keyMoments: analysis.keyMoments,
    firstRunSeconds: Number((analyzeMs / 1000).toFixed(1)),
    cachedRerunMs: rerunMs,
  }, null, 2));

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

main().catch((err) => {
  console.error('smoke test error:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
