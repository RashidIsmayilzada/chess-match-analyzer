import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Color, Profile, TimeClass } from '@chess-analyzer/core';
import { api, errorMessage, type GameListItem, type GamesQuery } from '../api/client';
import { useEvent } from '../hooks/useEvents';

const PAGE_SIZE = 25;
const TIME_CLASSES: readonly TimeClass[] = ['bullet', 'blitz', 'rapid'];

type Outcome = 'W' | 'L' | 'D';

interface AccuracyPair {
  white: number;
  black: number;
}

/** Accuracy loaded lazily from GET /games/:id, cached for the session. */
const accuracyCache = new Map<string, AccuracyPair>();

function sideOf(game: GameListItem): Color {
  return game.black.username.toLowerCase() === game.profileUsername.toLowerCase() ? 'b' : 'w';
}

function outcomeOf(game: GameListItem): Outcome {
  if (game.result === '1/2-1/2' || game.result === '*') return 'D';
  const side = sideOf(game);
  const whiteWon = game.result === '1-0';
  return whiteWon === (side === 'w') ? 'W' : 'L';
}

function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function parseTimeClass(v: string | null): TimeClass | undefined {
  return v !== null && (TIME_CLASSES as readonly string[]).includes(v) ? (v as TimeClass) : undefined;
}

function parseAnalyzed(v: string | null): boolean | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

export function GamesPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const profile = params.get('profile') ?? '';
  const timeClass = parseTimeClass(params.get('timeClass'));
  const analyzed = parseAnalyzed(params.get('analyzed'));
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [items, setItems] = useState<GameListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [accuracies, setAccuracies] = useState<Map<string, AccuracyPair>>(new Map(accuracyCache));
  const [progressByGame, setProgressByGame] = useState<Map<string, number>>(new Map());
  const reloadTimer = useRef<number | undefined>(undefined);

  const query = useMemo<GamesQuery>(
    () => ({
      profile: profile || undefined,
      timeClass,
      analyzed,
      page,
      pageSize: PAGE_SIZE,
    }),
    [profile, timeClass, analyzed, page],
  );

  const updateParams = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next);
  };

  useEffect(() => {
    api.profiles().then(setProfiles).catch(() => setProfiles([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.games(query);
      setItems(res.items);
      setTotal(res.total);
      setError(undefined);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reload (debounced) when any analysis job changes state so the analyzed badge updates.
  useEvent('job-updated', (ev) => {
    if (ev.status !== 'done' && ev.status !== 'failed' && ev.status !== 'cancelled') return;
    if (ev.gameId !== undefined) {
      accuracyCache.delete(ev.gameId);
      setProgressByGame((m) => {
        if (!m.has(ev.gameId as string)) return m;
        const next = new Map(m);
        next.delete(ev.gameId as string);
        return next;
      });
    }
    if (reloadTimer.current !== undefined) window.clearTimeout(reloadTimer.current);
    reloadTimer.current = window.setTimeout(() => void load(), 400);
  });

  useEvent('analysis-progress', (ev) => {
    setProgressByGame((m) => {
      const next = new Map(m);
      if (ev.status === 'done' || ev.status === 'failed') next.delete(ev.gameId);
      else next.set(ev.gameId, ev.progress);
      return next;
    });
  });

  // Lazily fetch accuracy for analysed rows that do not carry it.
  useEffect(() => {
    const missing = items.filter(
      (g) => g.analyzed && g.accuracy === undefined && !accuracyCache.has(g.id),
    );
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      const queue = [...missing];
      const worker = async () => {
        while (!cancelled) {
          const g = queue.shift();
          if (g === undefined) return;
          try {
            const d = await api.game(g.id);
            if (d.analysis !== undefined) {
              accuracyCache.set(g.id, { white: d.analysis.white.accuracy, black: d.analysis.black.accuracy });
              if (!cancelled) setAccuracies(new Map(accuracyCache));
            }
          } catch {
            /* skip */
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
    })();
    return () => {
      cancelled = true;
    };
  }, [items]);

  const pageIds = items.map((g) => g.id);
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const toggleAll = () => {
    setSelected((s) => {
      const next = new Set(s);
      if (allOnPageSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const queueGames = async (ids: string[]) => {
    if (ids.length === 0) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const { jobIds } = await api.analyzeBatch(ids);
      setNotice(`Queued ${jobIds.length} game${jobIds.length === 1 ? '' : 's'} for analysis.`);
      setSelected(new Set());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const analyzeSelected = () => void queueGames([...selected]);

  const analyzeAllUnanalysed = async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      const ids: string[] = [];
      const pageSize = 200;
      let p = 1;
      for (;;) {
        const res = await api.games({
          profile: profile || undefined,
          timeClass,
          analyzed: false,
          page: p,
          pageSize,
        });
        ids.push(...res.items.filter((g) => !g.analyzed).map((g) => g.id));
        if (res.items.length < pageSize || ids.length >= res.total) break;
        p += 1;
      }
      if (ids.length === 0) {
        setNotice('No unanalysed games match the current filters.');
        return;
      }
      await queueGames(ids);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const accuracyFor = (g: GameListItem): string => {
    const pair = g.accuracy ?? accuracies.get(g.id);
    if (pair === undefined) return g.analyzed ? '…' : '—';
    const mine = sideOf(g) === 'w' ? pair.white : pair.black;
    return mine.toFixed(1);
  };

  return (
    <div>
      <div className="page-header">
        <h1>Games</h1>
        <div className="btn-group">
          <button className="btn" disabled={busy || selected.size === 0} onClick={analyzeSelected}>
            Analyze selected{selected.size > 0 ? ` (${selected.size})` : ''}
          </button>
          <button className="btn primary" disabled={busy} onClick={() => void analyzeAllUnanalysed()}>
            Analyze all unanalysed
          </button>
        </div>
      </div>

      <div className="toolbar">
        <select value={profile} onChange={(e) => updateParams({ profile: e.target.value, page: undefined })}>
          <option value="">All profiles</option>
          {profiles.map((p) => (
            <option key={p.username} value={p.username}>
              {p.username} ({p.gameCount})
            </option>
          ))}
        </select>
        <select
          value={timeClass ?? ''}
          onChange={(e) => updateParams({ timeClass: e.target.value, page: undefined })}
        >
          <option value="">All time classes</option>
          {TIME_CLASSES.map((tc) => (
            <option key={tc} value={tc}>
              {tc}
            </option>
          ))}
        </select>
        <select
          value={analyzed === undefined ? '' : String(analyzed)}
          onChange={(e) => updateParams({ analyzed: e.target.value, page: undefined })}
        >
          <option value="">Analysed and not</option>
          <option value="true">Analysed only</option>
          <option value="false">Not analysed</option>
        </select>
        <span className="grow" />
        <span className="muted small">
          {loading ? 'Loading…' : `${total} game${total === 1 ? '' : 's'}`}
        </span>
      </div>

      {error !== undefined && <div className="alert error">{error}</div>}
      {notice !== undefined && <div className="alert success">{notice}</div>}

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>
                <input type="checkbox" checked={allOnPageSelected} onChange={toggleAll} aria-label="Select all" />
              </th>
              <th>Date</th>
              <th>Opponent</th>
              <th>Colour</th>
              <th>Result</th>
              <th>Time</th>
              <th className="num">Rating</th>
              <th className="num">Opp.</th>
              <th className="num">Accuracy</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading && (
              <tr>
                <td colSpan={11} className="empty">
                  No games. <Link to="/">Import some</Link>.
                </td>
              </tr>
            )}
            {items.map((g) => {
              const side = sideOf(g);
              const me = side === 'w' ? g.white : g.black;
              const opp = side === 'w' ? g.black : g.white;
              const outcome = outcomeOf(g);
              const progress = progressByGame.get(g.id);
              return (
                <tr key={g.id} className={selected.has(g.id) ? 'selected' : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(g.id)}
                      onChange={() => toggle(g.id)}
                      aria-label={`Select game ${g.id}`}
                    />
                  </td>
                  <td>{formatDate(g.endTime)}</td>
                  <td>
                    <Link to={`/games/${encodeURIComponent(g.id)}`}>{opp.username}</Link>
                  </td>
                  <td>
                    <span className={`color-swatch ${side}`} /> {side === 'w' ? 'White' : 'Black'}
                  </td>
                  <td>
                    <span className={`result-pill ${outcome}`}>{outcome}</span>
                  </td>
                  <td>
                    {g.timeClass} <span className="dim">{g.timeControl}</span>
                  </td>
                  <td className="num">{me.rating || '—'}</td>
                  <td className="num">{opp.rating || '—'}</td>
                  <td className="num">{accuracyFor(g)}</td>
                  <td>
                    {progress !== undefined ? (
                      <span className="badge running">{Math.round(progress * 100)}%</span>
                    ) : g.analyzed ? (
                      <span className="badge ok">Analysed</span>
                    ) : (
                      <span className="badge muted">Not analysed</span>
                    )}
                  </td>
                  <td>
                    <Link className="btn small" to={`/games/${encodeURIComponent(g.id)}`}>
                      {g.analyzed ? 'Review' : 'Open'}
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <span>
          Page {page} of {totalPages}
        </span>
        <div className="btn-group">
          <button className="btn small" disabled={page <= 1} onClick={() => updateParams({ page: String(page - 1) })}>
            Previous
          </button>
          <button
            className="btn small"
            disabled={page >= totalPages}
            onClick={() => updateParams({ page: String(page + 1) })}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
