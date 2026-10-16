# chess-analyzer

A local, single-user web app that imports a chess.com user's games and produces a
chess.com-style Game Review: per-move classification (Brilliant, Great, Best, Excellent, Good,
Book, Inaccuracy, Mistake, Miss, Blunder), accuracy, estimated rating, opening name, eval graph
and key moments. Everything runs on your machine: Stockfish 19 does the analysis, SQLite stores
games and cached positions.

`docs/ARCHITECTURE.md` is the contract between the packages (types, classification rules, HTTP
API, database schema, UI routes). Read it before changing anything shared.

## Layout

```
packages/core     @chess-analyzer/core    pure logic: UCI engine wrapper, PGN parsing, openings
                                          book, classifier, game analysis orchestration
packages/server   @chess-analyzer/server  Fastify 5 API, SQLite (Drizzle), chess.com importer,
                                          analysis queue, SSE progress events
packages/web      @chess-analyzer/web     Vite + React 19 UI (chessground board, recharts graph)
engines/          Stockfish binary (downloaded by scripts/setup-engine.sh, git-ignored)
data/openings/    Lichess chess-openings dataset (ECO, name, moves)
data/fixtures/    sample PGNs and a chess.com archive used by tests
scripts/          setup-engine.sh, smoke.sh (+ smoke.mjs), calibrate.mjs
```

## Setup

Requirements: Node 22+, npm 10+, Linux x86-64 (for the bundled Stockfish download; any UCI
engine works if you point `enginePath` at it).

```sh
npm install                 # installs all workspaces (better-sqlite3 builds a native module)
scripts/setup-engine.sh     # downloads Stockfish 19 into engines/stockfish
npm run build -w packages/core   # server and web import core's compiled types from dist/
```

## Development

```sh
npm run dev        # server on http://localhost:3001 + Vite on http://localhost:5173
npm run dev:server # just the API (tsx watch)
npm run dev:web    # just the UI (proxies /api to :3001)
```

Open http://localhost:5173, enter a chess.com username on the Import page, then analyse games
from the Games page. Analysis progress streams over `/api/events`.

Server environment variables: `PORT` (3001), `HOST`, `DB_PATH` (`data/chess-analyzer.db`),
`ENGINE_PATH` (overrides the stored engine path), `LOG_LEVEL`.

## Build and run in production mode

```sh
npm run build                     # core -> server -> web
node packages/server/dist/index.js
```

The server serves `packages/web/dist` with an SPA fallback when it exists, so the whole app is
on http://localhost:3001.

## Tests

```sh
npm run typecheck   # tsc for all three packages
npm test            # vitest: core (engine tests use the real Stockfish binary) + server
```

Per package: `npx vitest run src/classify` from `packages/core`, etc.

## Smoke test (real engine, real chess.com API)

```sh
scripts/smoke.sh [username]        # default user: xseven123
```

Builds core and server, starts the server on a scratch database (`data/smoke.db`), imports the
user's three latest games, analyses the first at depth 12, verifies the resulting
`GameAnalysis` (move count, classifications, book moves, opening, accuracies, ratings, key
moments, no NaN/null), checks `/api/openings?q=london` and `/api/health`, and confirms that a
repeat analysis is served from the position cache in well under a second. The server log goes
to `data/smoke-server.log`. Environment: `PORT`, `SMOKE_DB`, `SMOKE_LOG`, `SMOKE_DEPTH`.

## Tuning classification thresholds

Every tunable number lives in `packages/core/src/config/thresholds.ts` (`DEFAULT_THRESHOLDS`,
documented field by field). The classifier itself contains no magic numbers; the rules it
applies are specified in `docs/ARCHITECTURE.md` ("Classification rules").

Two ways to tune:

1. **At runtime, per installation**: the Settings page (`/settings`) has a thresholds editor.
   Whatever you save is stored as a deep-partial override in the `settings` table and merged
   over the defaults (`PUT /api/settings { thresholds: { bands: { good: 0.06 } } }`;
   `DELETE /api/settings` resets). Changing thresholds does not invalidate cached engine
   positions, so re-analysing a game after a tweak is fast.
2. **Changing the defaults**: edit `thresholds.ts`, run `npx vitest run src/classify` in
   `packages/core` (the classifier is developed test-first against fixture positions; update the
   boundary tests when you move a band) and rebuild core.

Things worth knowing when tuning:

- Win probabilities are mover POV, 0..1, from a logistic on centipawns (`winProb.k`); mate scores
  are converted with `winProb.mateCp`. Band thresholds are win-probability losses.
- `brilliant.minSacrificeValue` is NET material (SEE loss minus what the move captures): 2 lets
  exchange sacrifices and the Greek gift through, 3 requires a clean minor piece.
  `brilliant.maxWinProbBefore` (0.95) withholds Brilliant once the game is already decided.
- `great.excludeRecaptures` / `great.excludeFreeCaptures` keep obvious captures (taking back a
  traded piece, grabbing a hanging one) from being Great; `miss.minOwnLoss` (0.10) means only a
  mistake-sized give-back after the opponent's mistake is a Miss.
- `rating.evalClampCp` clamps evals before centipawn loss is computed so that noise in decisive
  positions does not wreck the average; `rating.byTimeClass` is a deliberately simple linear
  model of ACPL to rating.
- Engine settings (depth, MultiPV, threads, hash, movetime, engine path) are on the same page;
  MultiPV must be at least 2 for Great / Brilliant detection.

### Calibration report

`scripts/calibrate.mjs` (`npm run calibrate -- ...`) runs the real pipeline (`analyzeGame`, the
default opening book, a fresh Stockfish per game) over a few games and prints, per game, the
players, result, opening, each side's accuracy / estimated rating and a classification count
table, then the totals and every Brilliant / Great / Miss with ply, SAN, win probability
before/after, loss, evals (white POV), the engine's best and second-best move and the gross
sacrifice value, so you can compare them with chess.com's Game Review move by move.

```sh
npm run build -w packages/core                       # and -w packages/server for --username
node scripts/calibrate.mjs --username xseven123 --games 5 --depth 14 --threads 4
node scripts/calibrate.mjs --pgn data/fixtures/game1.pgn --pgn data/fixtures/game2.pgn --depth 14 --threads 1
```

Options: `--username` (latest N standard games from chess.com, via the server's importer client),
`--games` (5), `--pgn` (repeatable), `--depth` (14), `--threads` (4), `--multipv` (3), `--hash`
(256), `--engine` (`engines/stockfish`). Multi-threaded Stockfish is not deterministic: use
`--threads 1` when you compare runs. The report uses `DEFAULT_THRESHOLDS`, not the overrides
saved from the Settings page.
