# chess-analyzer architecture

A local, single-user web app that imports a chess.com user's games and produces a
chess.com-style Game Review: per-move classification (Brilliant, Great, Best, Excellent,
Good, Book, Inaccuracy, Mistake, Miss, Blunder), accuracy, estimated rating, opening name,
eval graph and key moments.

## Repository layout

```
engines/stockfish              Stockfish 19 (Linux x86-64 universal). Already present.
data/openings/{a..e}.tsv       Lichess chess-openings dataset (eco, name, pgn). Already present.
data/chess-analyzer.db         SQLite database (created at runtime, git-ignored).
packages/core                  @chess-analyzer/core  - pure logic, no HTTP, no DB
packages/server                @chess-analyzer/server - Fastify API, SQLite (Drizzle), queue
packages/web                   @chess-analyzer/web    - Vite + React UI
docs/                          this file and other docs
```

npm workspaces, TypeScript everywhere, ESM (`"type": "module"`, NodeNext resolution,
so relative imports inside packages must include the `.js` extension).

Installed versions: chess.js 1.4, fastify 5, drizzle-orm 0.45, better-sqlite3 13, vite 8,
react 19, @lichess-org/chessground 10, recharts 3, vitest 5, typescript 7.

## packages/core — module map

Entry: `src/index.ts` re-exports everything public.

| Module | File | Responsibility |
|---|---|---|
| types | `src/types.ts` | Shared domain types (DO NOT change shapes without updating all consumers). |
| thresholds | `src/config/thresholds.ts` | Every tunable constant. `DEFAULT_THRESHOLDS`, `PIECE_VALUES`. |
| engine | `src/engine/uci.ts` | `UciEngine` class: spawn a UCI binary, set options, `analyse(fen, settings) => PositionAnalysis`. Scores normalised to white POV. Serialises concurrent calls (one search at a time). Terminal positions (checkmate / stalemate) return `lines: []`. `PositionAnalysis.depth` is the depth actually reached. |
| openings | `src/openings/index.ts` | `OpeningBook`: loads the TSVs, `lookupByMoves(sanMoves[]) => OpeningRef | undefined`, `isBookMove(sanMovesSoFar, san)`, `longestMatch(sanMoves[]) => { opening, plies }`, `search(query)` and `list()` for the Openings browser. Also `loadDefaultBook(dataDir)`. |
| winprob | `src/classify/winprob.ts` | `cpToWinProb(cp, k)`, `scoreToWinProb(score: EngineScore, color: Color, t, sideToMove?)` (mover POV), `scoreToCp(score, mateCp)`, `positionScoreToCp(score, sideToMove, mateCp)`, `isMateZero`, `scoreFromMoverPov`. `mate 0` means "the side to move is checkmated" and carries no sign, so it can only be converted together with the side to move: `scoreToCp` throws on it, `positionScoreToCp` / `scoreToWinProb(..., sideToMove)` resolve it. |
| sacrifice | `src/classify/sacrifice.ts` | `detectSacrifice(fenBefore, uci) => { isSacrifice, value }`: net material the mover leaves en prise after the move that cannot be recouped by a simple recapture (SEE-style). "En prise" means the opponent can LEGALLY capture it on their next move: after a check only check-escaping captures count, pinned attackers do not count. After a checkmating move (no legal replies) the attack-based notion is used so a mating sacrifice is still a sacrifice. |
| classify | `src/classify/index.ts` | `classifyMove(ctx: MoveContext, t: Thresholds) => Classification` plus helpers per rule (`isBrilliant`, `isGreat`, `isMiss`, `bandFor`). |
| accuracy | `src/classify/accuracy.ts` | `moveAccuracy(winProbLoss, t)`, `gameAccuracy(moves, color, t)`, `estimateRating(avgCpLoss, timeClass, t)`. |
| pgn | `src/pgn/index.ts` | `parsePgn(pgn) => { headers, moves: {san, uci, fenBefore, fenAfter, clockSeconds?}[] }` using chess.js. Handles chess.com `{[%clk ...]}` comments. |
| analyze | `src/analyze/index.ts` | `analyzeGame({ pgn, timeClass, engine, book, settings, thresholds, onProgress }) => GameAnalysis`. Orchestrates: parse → analyse every position (with a `PositionCache` interface for memoisation) → classify → summarise → key moments. Engine results are normalised to the REQUESTED depth before caching (`cache.get` is keyed by the requested settings). Positions with exactly one legal move are never sent to the engine (Stockfish answers them with a meaningless `cp 0`): their eval is derived from the position after the forced move (`deriveForcedMoveAnalysis`). Terminal positions (engine returns `lines: []`) get `evalBefore`/`evalAfter` from `terminalScore`: checkmate is `{ type: 'mate', value: 0 }` (the side to move is mated), every other game end is `cp 0`; a cp value never stands in for a mate. `opening.lastBookPly` is the ply of the last move classified `book`; `opening.eco`/`name` come from the longest named line that is a prefix of the game, which may be shorter (e.g. 1.d4 Nf6 2.Nc3 is book because named A45 lines continue from it, while the name is the 2-ply "Indian Defense"). |

`MoveContext` (input to `classifyMove`):

```ts
interface MoveContext {
  ply: number; color: Color; san: string; uci: string;
  fenBefore: string; fenAfter: string;
  position: PositionAnalysis;        // engine lines for fenBefore (white POV)
  positionAfter: PositionAnalysis;   // engine lines for fenAfter
  isBook: boolean;
  legalMoveCount: number;            // in fenBefore
  previous?: { winProbLoss: number; winProbBefore: number; winProbAfter: number }; // opponent's previous move, mover POV of THAT move
}
```

### Classification rules (must match this spec; constants from `Thresholds`)

Order of evaluation: **book → brilliant → great → miss → bands**.

1. **book** — `isBook` is true. Book moves stop at the first non-book move: once a move is
   out of book, no later move is book. A move is book when the moves so far plus this move are a
   prefix of at least one line in the dataset (so book can extend past the last *named* line).
2. Compute `winProbBefore` = mover's win prob of best line in `position` (i.e. the eval of the
   position before the move), `winProbAfter` = mover's win prob of best line in `positionAfter`,
   `loss = max(0, winProbBefore - winProbAfter)`.
   `isBest` = the played uci equals `position.lines[0].pv[0]`, OR the eval after is at least as
   good for the mover as the best line's eval (cp and mate distances compared through
   `scoreToCp`, so mate-in-3 followed by mate-in-2 counts as equal).
3. **brilliant** — all of:
   - `loss <= brilliant.maxLossFromBest`
   - `detectSacrifice(fenBefore, uci).value >= brilliant.minSacrificeValue`. The value is NET:
     SEE loss minus the material the move itself captures, so the Greek gift Bxh7+ Kxh7 nets
     3 - 1 = 2 and an exchange sacrifice nets 2; the default minimum is 2. The moving piece type
     does not matter: a pawn capture that leaves a rook hanging counts.
   - mover's cp eval before the move `<= brilliant.maxEvalBeforeCp`, OR
     (`allowWhenWinningIfMate` and `positionAfter` best line is a mate for the mover).
   - `winProbAfter >= brilliant.minWinProbAfter`.
   - not a mate-in-one when `excludeMateInOne`.
4. **great** — all of:
   - `loss <= great.maxLossFromBest` and `isBest`.
   - `position.lines[1]` exists and mover win prob of line 1 minus line 2 `>= great.minGapToSecondBest`.
   - `great.minWinProbBefore <= winProbBefore <= great.maxWinProbBefore`.
   - `legalMoveCount > 1` when `excludeForcedMoves`.
5. **miss** — all of:
   - `previous` exists and `previous.winProbLoss >= miss.minOpponentLoss` (opponent just made a mistake or blunder).
   - `loss >= miss.minOwnLoss`.
   - `loss / previous.winProbLoss >= miss.minGiveBackFraction` (the mover gave back at least that share of what the opponent handed over).
6. **bands** — `isBest` → best; `loss <= bands.excellent` → excellent; `<= bands.good` → good;
   `<= bands.inaccuracy` → inaccuracy; `<= bands.mistake` → mistake; else blunder.

Accuracy per move (Lichess): `a * exp(b * (loss * 100)) + c`, clamped 0..100.
Game accuracy per player = mean of per-move accuracies for that colour, book moves count as 100.
Centipawn loss per move = `max(0, clamp(cpBefore) - clamp(cpAfter))` with both mover-POV evals
clamped to `+-rating.evalClampCp` (mate scores converted through `winProb.mateCp` first), so
eval noise in decisive positions does not inflate the average.
`averageCpLoss` = mean cpLoss over the player's non-book moves.
Estimated rating = `clamp(base - slope * averageCpLoss, min, max)` per time class.

Key moments: plies classified brilliant, great, miss, blunder, plus any ply whose
`|winProbBefore - winProbAfter| >= keyMoments.minSwing`, capped at `keyMoments.max`,
ordered by swing size then ply.

## packages/server

Fastify 5 on port 3001, CORS open for the Vite dev server (port 5173). Serves
`packages/web/dist` statically in production. Shutdown: a `preClose` hook ends every SSE
response (Fastify only closes idle sockets and waits for active ones, so this must happen before
the server closes), then `onClose` stops the queue (requeueing an interrupted job) and closes
the database; `app.close()` finishes promptly even with EventSource clients connected.

### Database (Drizzle + better-sqlite3, file `data/chess-analyzer.db`)

Schema in `src/db/schema.ts`, migrations applied programmatically at startup
(`drizzle-orm/better-sqlite3/migrator` with migrations in `src/db/migrations`, or
`CREATE TABLE IF NOT EXISTS` statements run at boot — either is acceptable).

| Table | Columns |
|---|---|
| profiles | username (pk, lowercase), last_sync (unix seconds of the last completed **full** sync; a "latest N" import leaves it untouched), created_at |
| games | id (pk, chess.com uuid), url, profile_username (fk; the profile that FIRST imported the game, its owner), time_class, time_control, rated, end_time, white_username, white_rating, white_result, black_username, black_rating, black_result, result, pgn, eco, opening_name, imported_at |
| game_profiles | game_id (fk, cascade), profile_username (fk), imported_at (pk = game_id+profile_username). Every profile a game was imported for: a game between two imported profiles is in both players' archives and is linked to both. The boot migration backfills it from `games`. Game lists, profile game counts and auto-analysis use this table, never `games.profile_username`. |
| position_analyses | fen, depth, multipv, engine (pk = fen+depth+multipv+engine), lines_json, created_at |
| game_analyses | game_id (fk), settings_key, analysis_json, analyzed_at (pk = game_id+settings_key) |
| settings | key (pk), value_json |
| jobs | id (pk), kind ('import' | 'analysis'), payload_json, status, progress, error, created_at, started_at, finished_at |

Settings stored: `analysis` → `AnalysisSettings`, `thresholds` → `Thresholds` (optional overrides),
`engineNames` → engine name per binary path (remembered after the first start so the settings key
is known before the engine runs).
Defaults: depth 18, multiPv 3, threads 8, hashMb 512, enginePath `engines/stockfish`.

### chess.com importer (`src/import/chesscom.ts`)

Public API, no auth. **Usernames must be lowercased in URLs.** Send a `User-Agent` header.
- `GET https://api.chess.com/pub/player/{u}` → 404 if unknown.
- `GET https://api.chess.com/pub/player/{u}/games/archives` → `{ archives: string[] }`.
- `GET {archive}` → `{ games: [...] }` with `uuid, url, pgn, time_class, time_control, rated, end_time, rules, white{username,rating,result}, black{...}, eco`.
- Keep only `rules === 'chess'` and `time_class in ('bullet','blitz','rapid')`. Count skipped.
- "latest N" mode: walk archives from newest, stop once N kept games collected.
- "all" mode: every archive. On resync, only fetch months >= last_sync month. `last_sync` is written only when an "all" import completes, so an "all" import after a "latest N" import still walks the whole history.
- A game that is already stored (imported for another profile) is updated in place except for `profile_username` (the first importer stays the owner) and is linked to the importing profile in `game_profiles`.
- Parse `[ECO ...]` and `[ECOUrl ...]` headers: opening name = last path segment of ECOUrl with `-` → space, strip the move-list suffix after `...` if present.

### Analysis queue (`src/queue/`)

One worker, one Stockfish process reused across jobs. Jobs persisted in `jobs`. Progress
events broadcast over SSE. The engine is restarted when enginePath / threads / hashMb change,
but only between jobs: a running analysis holds a lease on the engine (`EngineManager.lease`)
and every other `acquire` (e.g. `/api/health`) gets the running engine as-is until the job
finishes. Position cache: `position_analyses` table keyed by
(fen, depth, multipv, engine) where depth is the REQUESTED depth. Cancelling a running job
stops the engine search (`stop`). Running jobs found at boot are re-queued.

### HTTP API (all JSON, prefix `/api`)

| Method | Path | Body / query | Response |
|---|---|---|---|
| GET | /profiles | | `Profile[]` |
| POST | /import | `{ username, mode: 'all'|'latest', count?: number, autoAnalyzeLatest?: number }` | `{ jobId }` |
| GET | /import/:jobId | | `ImportJob` |
| GET | /games | `?profile=&timeClass=&analyzed=&page=&pageSize=` | `{ items: GameRecord[], total }` (analysed rows carry `accuracy: { white, black }`). `profile` matches through `game_profiles`; the returned `profileUsername` is that profile. |
| GET | /games/:id | `?profile=` | `{ game: GameRecord, analysis?: GameAnalysis }`. With `profile` (linked to the game) `game.profileUsername` is that profile, so the UI orients the board from its side; otherwise the owner. |
| POST | /games/:id/analyze | | `{ jobId }` |
| POST | /analyze/batch | `{ gameIds: string[] }` | `{ jobIds: string[] }` |
| GET | /jobs | `?status=&kind=` | `AnalysisJob[]` (default `kind=analysis`); `kind=import` → `ImportJob[]` |
| DELETE | /jobs/:id | | cancel |
| GET | /events | | SSE: `import-progress`, `analysis-progress`, `job-updated` |
| GET | /settings | | `{ analysis: AnalysisSettings, thresholds: Thresholds }` |
| PUT | /settings | deep-partial of the above (`movetimeMs: null` clears it) | updated settings |
| DELETE | /settings | | reset overrides to defaults |
| GET | /openings | `?q=` | `{ eco, name, pgn }[]` (max 200) |
| GET | /openings/:eco | | lines for that ECO |
| GET | /health | | `{ ok, engine: string, queueIdle, sseClients, engineRestartPending }` (starts the engine lazily; never restarts an engine a running job holds, even if the engine settings changed, so `engineRestartPending` says a restart is due at the next job) |

SSE payloads (`data:` is JSON):

- `analysis-progress`: `{ jobId, gameId, progress }` with progress 0..1.
- `import-progress`: `{ jobId, username, status, progress, imported, skipped, archivesFetched?, archivesTotal? }`.
- `job-updated`: `{ kind: 'import' | 'analysis', job: ImportJob | AnalysisJob }`, emitted on every status change.

## packages/web

Vite + React 19 + react-router. Dark, chess.com-like theme. Pages:

| Route | Page |
|---|---|
| `/` | Import: username field, mode (all / latest N), "auto-analyze latest 10" toggle, progress; list of imported profiles. |
| `/games` | Game list with profile + time-class + analyzed filters, "Analyze selected" / "Analyze all" buttons, queue status bar. |
| `/games/:id` | Game Review: board (chessground), eval bar, move list with classification icons and colours, eval graph (recharts), opening name + ECO, per-player accuracy + estimated rating + classification counts, key moments, best-move arrow, keyboard navigation (←/→/Home/End), flip board. |
| `/openings` | Openings browser: search by name/ECO, click a line to play it on a board. |
| `/settings` | Engine settings form (depth presets 18/20/24 + free field, MultiPV, threads, hash, engine path, movetime), thresholds editor (JSON or form). |

Classification colours (hex): brilliant `#1baca6`, great `#5c8bb0`, best `#95b776`, excellent `#96bc4b`,
good `#96af8b`, book `#a88865`, inaccuracy `#f0c15c`, mistake `#e58f2a`, miss `#ee6b55`, blunder `#ca3431`.
Icons are our own SVGs in `src/icons/`.

Dev: `npm run dev` starts both; Vite proxies `/api` to `http://localhost:3001`.
