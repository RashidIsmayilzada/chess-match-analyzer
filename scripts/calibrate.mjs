#!/usr/bin/env node
// Calibration report: run the real analysis pipeline over a handful of games and print what the
// classifier awarded, so a human can compare it with chess.com's Game Review.
//
//   node scripts/calibrate.mjs --username xseven123 --games 5 --depth 14 --threads 4
//   node scripts/calibrate.mjs --pgn data/fixtures/game1.pgn --pgn data/fixtures/game2.pgn --depth 14 --threads 1
//
// Options:
//   --username <name>   fetch that chess.com user's latest standard games (bullet/blitz/rapid)
//   --games <n>         how many games to fetch with --username (default 5)
//   --pgn <file>        analyse the game(s) in a PGN file; repeatable; may be combined with --username
//   --depth <n>         search depth (default 14)
//   --threads <n>       engine threads (default 4; use 1 for reproducible results)
//   --multipv <n>       engine lines per position (default 3, Great/Brilliant need >= 2)
//   --hash <mb>         engine hash (default 256)
//   --engine <path>     UCI engine binary (default engines/stockfish)
//
// Needs `npm run build -w packages/core` (and `-w packages/server` for --username).
// Progress goes to stderr, the report to stdout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_CLASSIFICATIONS, DEFAULT_THRESHOLDS, UciEngine, analyzeGame, loadDefaultBook } from '@chess-analyzer/core';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HIGHLIGHT = ['brilliant', 'great', 'miss'];

function usage(message) {
  if (message) console.error(`calibrate: ${message}`);
  console.error(
    'usage: node scripts/calibrate.mjs [--username <name> [--games N]] [--pgn file.pgn ...] [--depth N] [--threads N] [--multipv N] [--hash MB] [--engine path]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { username: undefined, games: 5, pgn: [], depth: 14, threads: 4, multipv: 3, hash: 256, engine: 'engines/stockfish' };
  const numeric = new Set(['games', 'depth', 'threads', 'multipv', 'hash']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') usage();
    if (!arg.startsWith('--')) usage(`unexpected argument "${arg}"`);
    const key = arg.slice(2);
    const value = argv[++i];
    if (value === undefined) usage(`${arg} needs a value`);
    if (key === 'pgn') opts.pgn.push(value);
    else if (key === 'username' || key === 'engine') opts[key] = value;
    else if (numeric.has(key)) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) usage(`${arg} must be a positive integer`);
      opts[key] = n;
    } else usage(`unknown option ${arg}`);
  }
  if (!opts.username && opts.pgn.length === 0) usage('give --username and/or --pgn');
  return opts;
}

// ---------------------------------------------------------------------------
// Game sources
// ---------------------------------------------------------------------------

function pgnHeaders(pgn) {
  const headers = {};
  for (const m of pgn.matchAll(/^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/gm)) headers[m[1]] = m[2];
  return headers;
}

/** chess.com's rule: estimated duration = base + 40 * increment. */
function timeClassFromControl(control) {
  const [base, inc] = String(control ?? '').split('+').map(Number);
  if (!Number.isFinite(base)) return 'blitz';
  const total = base + 40 * (Number.isFinite(inc) ? inc : 0);
  if (total < 180) return 'bullet';
  if (total < 600) return 'blitz';
  return 'rapid';
}

function gamesFromPgnFile(file) {
  const text = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
  const chunks = text.split(/\r?\n\s*\r?\n(?=\[Event )/).map((s) => s.trim()).filter(Boolean);
  return chunks.map((pgn, i) => {
    const h = pgnHeaders(pgn);
    return {
      id: chunks.length > 1 ? `${file}#${i + 1}` : file,
      source: h.Link ?? file,
      pgn,
      timeClass: timeClassFromControl(h.TimeControl),
      white: { username: h.White ?? 'White', rating: Number(h.WhiteElo) || undefined },
      black: { username: h.Black ?? 'Black', rating: Number(h.BlackElo) || undefined },
      result: h.Result ?? '*',
    };
  });
}

async function gamesFromChesscom(username, count) {
  let mod;
  try {
    mod = await import(path.join(REPO_ROOT, 'packages/server/dist/import/chesscom.js'));
  } catch (err) {
    throw new Error(`could not load the server's chess.com client (run npm run build -w packages/server): ${err.message}`);
  }
  const { ChesscomClient, isKeptGame } = mod;
  const client = new ChesscomClient();
  const archives = await client.getArchives(username);
  const kept = [];
  for (const url of [...archives].reverse()) {
    console.error(`fetching ${url}`);
    const games = (await client.getArchive(url)).filter(isKeptGame).sort((a, b) => b.end_time - a.end_time);
    for (const g of games) {
      if (kept.length >= count) break;
      if (g.pgn) kept.push(g);
    }
    if (kept.length >= count) break;
  }
  return kept.map((g) => ({
    id: g.uuid,
    source: g.url,
    pgn: g.pgn,
    timeClass: g.time_class,
    white: { username: g.white.username, rating: g.white.rating },
    black: { username: g.black.username, rating: g.black.rating },
    result: pgnHeaders(g.pgn).Result ?? '*',
  }));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const pct = (p) => `${(p * 100).toFixed(1)}%`;
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function moveLabel(m) {
  const n = Math.ceil(m.ply / 2);
  return m.color === 'w' ? `${n}.${m.san}` : `${n}...${m.san}`;
}

function countsTable(rows) {
  // rows: [{ label, counts }]
  const widths = rows.map((r) => Math.max(r.label.length, 5));
  const lines = [`  ${pad('', 12)}${rows.map((r, i) => lpad(r.label, widths[i] + 2)).join('')}`];
  for (const c of ALL_CLASSIFICATIONS) {
    lines.push(`  ${pad(c, 12)}${rows.map((r, i) => lpad(r.counts[c] ?? 0, widths[i] + 2)).join('')}`);
  }
  return lines.join('\n');
}

function scoreText(score) {
  if (!score) return '?';
  if (score.type === 'mate') return `#${score.value}`;
  return (score.value / 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const games = [];
  for (const file of opts.pgn) games.push(...gamesFromPgnFile(file));
  if (opts.username) games.push(...(await gamesFromChesscom(opts.username, opts.games)));
  if (games.length === 0) throw new Error('no games to analyse');

  const enginePath = path.resolve(REPO_ROOT, opts.engine);
  const book = await loadDefaultBook();
  const settings = { depth: opts.depth, multiPv: opts.multipv, threads: opts.threads, hashMb: opts.hash, enginePath };
  const thresholds = DEFAULT_THRESHOLDS;

  const totals = { all: {}, user: {} };
  const highlights = [];
  let engineName = '';

  console.log(
    `calibrate: ${games.length} game(s), depth ${opts.depth}, multipv ${opts.multipv}, threads ${opts.threads}, hash ${opts.hash} MB`,
  );

  for (const [index, game] of games.entries()) {
    // A fresh engine per game: no hash carried over between games, so a run with --threads 1
    // gives the same result for a game regardless of what was analysed before it.
    const engine = new UciEngine({ enginePath, threads: opts.threads, hashMb: opts.hash });
    engineName = await engine.start();
    const started = Date.now();
    let lastShown = -1;
    let analysis;
    try {
      analysis = await analyzeGame({
        gameId: game.id,
        pgn: game.pgn,
        timeClass: game.timeClass,
        whiteUsername: game.white.username,
        blackUsername: game.black.username,
        whiteRating: game.white.rating,
        blackRating: game.black.rating,
        engine,
        book,
        settings,
        thresholds,
        onProgress: (p) => {
          const step = Math.floor(p * 10);
          if (step !== lastShown) {
            lastShown = step;
            process.stderr.write(`\r[${index + 1}/${games.length}] ${game.id}: ${Math.round(p * 100)}%   `);
          }
        },
      });
    } finally {
      await engine.quit();
    }
    process.stderr.write(`\r[${index + 1}/${games.length}] ${game.id}: done in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

    const { white, black, opening } = analysis;
    const rating = (r) => (r ? ` (${r})` : '');
    console.log('');
    console.log(`=== Game ${index + 1}: ${white.username}${rating(white.rating)} vs ${black.username}${rating(black.rating)}  ${game.result}  [${game.timeClass}]`);
    console.log(`    ${game.source}`);
    console.log(`    Opening: ${opening.eco ? `${opening.eco} ` : ''}${opening.name} (book through ply ${opening.lastBookPly})`);
    for (const side of [white, black]) {
      console.log(
        `    ${pad(side.username, 20)} accuracy ${lpad(side.accuracy.toFixed(1), 5)}  est. rating ${lpad(side.estimatedRating, 4)}  avg cp loss ${side.averageCpLoss.toFixed(1)}`,
      );
    }
    console.log(countsTable([
      { label: 'White', counts: white.counts },
      { label: 'Black', counts: black.counts },
    ]));

    for (const c of ALL_CLASSIFICATIONS) {
      totals.all[c] = (totals.all[c] ?? 0) + white.counts[c] + black.counts[c];
      if (opts.username) {
        const mine = [white, black].find((s) => s.username.toLowerCase() === opts.username.toLowerCase());
        if (mine) totals.user[c] = (totals.user[c] ?? 0) + mine.counts[c];
      }
    }
    for (const m of analysis.moves) {
      if (HIGHLIGHT.includes(m.classification)) highlights.push({ game: index + 1, side: m.color === 'w' ? white.username : black.username, m });
    }
  }

  console.log('');
  console.log(`=== Totals over ${games.length} game(s) (${engineName})`);
  const rows = [{ label: 'Both sides', counts: totals.all }];
  if (opts.username && Object.keys(totals.user).length > 0) rows.push({ label: opts.username, counts: totals.user });
  console.log(countsTable(rows));

  console.log('');
  console.log(`=== Brilliant / Great / Miss (${highlights.length})`);
  if (highlights.length === 0) console.log('  (none)');
  for (const { game, side, m } of highlights) {
    const sac = m.isSacrifice ? `  sacrifice ${m.sacrificeValue ?? '?'}` : '';
    const second = m.secondBest ? `  2nd ${m.secondBest.move.san} ${scoreText(m.secondBest.score)}` : '';
    console.log(
      `  g${game} ply ${lpad(m.ply, 3)}  ${pad(moveLabel(m), 12)} ${pad(m.classification, 9)} ${pad(side, 18)} ` +
        `win ${pct(m.winProbBefore)} -> ${pct(m.winProbAfter)}  loss ${pct(m.winProbLoss)}  ` +
        `eval(W) ${scoreText(m.evalBefore)} -> ${scoreText(m.evalAfter)}  best ${m.bestMove.san || '?'}${second}${sac}`,
    );
  }
}

main().catch((err) => {
  console.error(`calibrate: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
