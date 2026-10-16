import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { Color } from '@chess-analyzer/core';
import { api, errorMessage, type OpeningLine } from '../api/client';
import { Board } from '../components/Board';
import { useKeyboardNav } from '../hooks/useKeyboardNav';
import { IconChevron, IconFlip } from '../icons';
import { parseMoveListPlies, START_FEN, uciToKeys, type Ply } from '../lib/chess';

const DEBOUNCE_MS = 200;

function lineKey(o: OpeningLine): string {
  return `${o.eco}|${o.name}|${o.pgn}`;
}

export function OpeningsPage(): JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<OpeningLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [selected, setSelected] = useState<OpeningLine | undefined>();
  const [ply, setPly] = useState(0);
  const [orientation, setOrientation] = useState<Color>('w');

  // Debounced search.
  useEffect(() => {
    const q = query.trim();
    const timer = window.setTimeout(() => {
      setLoading(true);
      api
        .openings(q)
        .then((r) => {
          setResults(r);
          setError(undefined);
        })
        .catch((err) => setError(errorMessage(err)))
        .finally(() => setLoading(false));
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const plies = useMemo<Ply[]>(() => {
    if (selected === undefined) return [];
    try {
      return parseMoveListPlies(selected.pgn);
    } catch {
      return [];
    }
  }, [selected]);

  const parseFailed = selected !== undefined && plies.length === 0 && selected.pgn.trim() !== '';
  const maxPly = plies.length;
  const clamp = useCallback((p: number) => Math.max(0, Math.min(maxPly, p)), [maxPly]);

  const select = (o: OpeningLine) => {
    setSelected(o);
    setPly(0);
    // Play the line through so the final position is shown immediately.
    window.setTimeout(() => setPly(Number.MAX_SAFE_INTEGER), 0);
  };

  useKeyboardNav({
    prev: () => setPly((p) => clamp(p - 1)),
    next: () => setPly((p) => clamp(p + 1)),
    first: () => setPly(0),
    last: () => setPly(maxPly),
    flip: () => setOrientation((o) => (o === 'w' ? 'b' : 'w')),
  });

  const currentPly = clamp(ply);
  const currentMove = currentPly > 0 ? plies[currentPly - 1] : undefined;
  const fen = currentMove?.fenAfter ?? START_FEN;
  const lastMove = currentMove !== undefined ? uciToKeys(currentMove.uci) : undefined;

  return (
    <div>
      <div className="page-header">
        <h1>Openings</h1>
      </div>

      <div className="openings">
        <div className="card">
          <input
            type="search"
            value={query}
            placeholder="Search by name or ECO (e.g. Sicilian, B90)"
            style={{ width: '100%', marginBottom: 10 }}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          {error !== undefined && <div className="alert error">{error}</div>}
          <div className="small muted" style={{ marginBottom: 6 }}>
            {loading ? 'Searching…' : `${results.length} line${results.length === 1 ? '' : 's'}${results.length >= 200 ? ' (showing first 200)' : ''}`}
          </div>
          <div className="opening-list">
            {results.map((o) => {
              const key = lineKey(o);
              const isSel = selected !== undefined && lineKey(selected) === key;
              return (
                <div
                  key={key}
                  className={`opening-item${isSel ? ' selected' : ''}`}
                  onClick={() => select(o)}
                  role="button"
                >
                  <span className="eco">{o.eco}</span>
                  <span className="name">{o.name}</span>
                  <span className="moves">{o.pgn}</span>
                </div>
              );
            })}
            {results.length === 0 && !loading && <div className="empty small">No openings match.</div>}
          </div>
        </div>

        <div className="card">
          {selected === undefined ? (
            <div className="empty">Select an opening to play it on the board.</div>
          ) : (
            <>
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>
                  <span className="mono" style={{ color: 'var(--accent)', marginRight: 8 }}>
                    {selected.eco}
                  </span>
                  {selected.name}
                </div>
              </div>
              <Board fen={fen} orientation={orientation} lastMove={lastMove} />
              {parseFailed && <div className="alert error">Could not parse this line: {selected.pgn}</div>}
              <div className="board-controls" style={{ marginTop: 10 }}>
                <button className="btn icon" onClick={() => setPly(0)} disabled={currentPly === 0} title="Start (Home)">
                  <IconChevron dir="first" />
                </button>
                <button className="btn icon" onClick={() => setPly(clamp(currentPly - 1))} disabled={currentPly === 0} title="Previous (←)">
                  <IconChevron dir="left" />
                </button>
                <button className="btn icon" onClick={() => setPly(clamp(currentPly + 1))} disabled={currentPly >= maxPly} title="Next (→)">
                  <IconChevron dir="right" />
                </button>
                <button className="btn icon" onClick={() => setPly(maxPly)} disabled={currentPly >= maxPly} title="End (End)">
                  <IconChevron dir="last" />
                </button>
                <button className="btn icon" onClick={() => setOrientation((o) => (o === 'w' ? 'b' : 'w'))} title="Flip board (F)">
                  <IconFlip />
                </button>
              </div>
              <div className="opening-moves" style={{ marginTop: 12 }}>
                {plies.map((p) => (
                  <span key={p.ply} style={{ display: 'inline-flex', gap: 4 }}>
                    {p.ply % 2 === 1 && <span className="n">{Math.ceil(p.ply / 2)}.</span>}
                    <span className={`m${p.ply === currentPly ? ' current' : ''}`} onClick={() => setPly(p.ply)}>
                      {p.san}
                    </span>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
