#!/usr/bin/env bash
# End-to-end smoke test: real Stockfish, real chess.com API.
#
# Builds core + server, starts the server on a scratch SQLite database, then runs
# scripts/smoke.mjs which imports 3 games for a chess.com user, analyses one at depth 12,
# verifies the analysis, checks the openings and health endpoints, and confirms a repeat
# analysis is served from the position cache.
#
# Usage: scripts/smoke.sh [username]      (env: PORT, SMOKE_DB, SMOKE_LOG, SMOKE_DEPTH)
set -euo pipefail
cd "$(dirname "$0")/.."

USERNAME="${1:-xseven123}"
PORT="${PORT:-3001}"
SMOKE_DB="${SMOKE_DB:-data/smoke.db}"
SMOKE_LOG="${SMOKE_LOG:-data/smoke-server.log}"

if [ ! -x engines/stockfish ]; then
  echo "engines/stockfish missing: run scripts/setup-engine.sh first" >&2
  exit 1
fi

echo "building core + server..."
npm run build -w packages/core >/dev/null
npm run build -w packages/server >/dev/null

rm -f "$SMOKE_DB" "$SMOKE_DB-wal" "$SMOKE_DB-shm"
mkdir -p "$(dirname "$SMOKE_LOG")"

echo "starting server on port $PORT (db: $SMOKE_DB, log: $SMOKE_LOG)"
PORT="$PORT" DB_PATH="$SMOKE_DB" node packages/server/dist/index.js >"$SMOKE_LOG" 2>&1 &
SERVER_PID=$!
cleanup() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "stopping server (pid $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

for _ in $(seq 1 60); do
  if curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server exited early; log:" >&2; cat "$SMOKE_LOG" >&2; exit 1
  fi
  sleep 1
done

SMOKE_DEPTH="${SMOKE_DEPTH:-12}" node scripts/smoke.mjs "http://localhost:$PORT" "$USERNAME"
