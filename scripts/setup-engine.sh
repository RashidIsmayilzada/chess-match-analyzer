#!/usr/bin/env bash
# Downloads Stockfish 19 (Linux x86-64 universal build) into engines/stockfish.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p engines
if [ -x engines/stockfish ]; then echo "engines/stockfish already present"; exit 0; fi
TMP=$(mktemp -d)
curl -sL -o "$TMP/sf.tar.gz" https://github.com/official-stockfish/Stockfish/releases/download/sf_19/stockfish-linux-x86-64-universal.tar.gz
tar xzf "$TMP/sf.tar.gz" -C "$TMP"
mv "$TMP/stockfish/stockfish-linux-x86-64-universal" engines/stockfish
chmod +x engines/stockfish
rm -rf "$TMP"
echo "Installed: $( (echo uci; echo quit) | engines/stockfish | grep '^id name')"
