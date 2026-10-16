import { useCallback, useEffect, useRef, useState, type FormEvent, type JSX } from 'react';
import { Link } from 'react-router-dom';
import type { ImportJob, Profile } from '@chess-analyzer/core';
import { api, errorMessage, type ImportRequest } from '../api/client';
import { useEvent } from '../hooks/useEvents';

const DEFAULT_LATEST = 10;
const DEFAULT_AUTO_ANALYZE = 10;

interface ActiveImport {
  jobId: string;
  username: string;
  mode: 'all' | 'latest';
  status: ImportJob['status'];
  progress: number;
  imported: number;
  skipped: number;
  error?: string;
  message?: string;
}

function formatSync(unixSeconds: number | undefined): string {
  if (unixSeconds === undefined) return 'never synced';
  return `synced ${new Date(unixSeconds * 1000).toLocaleString()}`;
}

export function ImportPage(): JSX.Element {
  const [username, setUsername] = useState('');
  const [mode, setMode] = useState<'all' | 'latest'>('latest');
  const [count, setCount] = useState(DEFAULT_LATEST);
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profilesError, setProfilesError] = useState<string | undefined>();
  const [active, setActive] = useState<ActiveImport | undefined>();
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [starting, setStarting] = useState(false);
  const pollTimer = useRef<number | undefined>(undefined);

  const loadProfiles = useCallback(async () => {
    try {
      setProfiles(await api.profiles());
      setProfilesError(undefined);
    } catch (err) {
      setProfilesError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  const applyJob = useCallback((job: ImportJob) => {
    setActive((a) => {
      if (a === undefined || a.jobId !== job.id) return a;
      const next: ActiveImport = {
        ...a,
        status: job.status,
        progress: job.progress,
        imported: job.imported,
        skipped: job.skipped,
      };
      if (job.error !== undefined) next.error = job.error;
      return next;
    });
  }, []);

  // Live updates from the event stream.
  useEvent('import-progress', (ev) => {
    setActive((a) => {
      if (a === undefined) return a;
      const mine = ev.jobId === a.jobId || (ev.username !== undefined && ev.username === a.username);
      if (!mine) return a;
      const next: ActiveImport = { ...a };
      if (ev.status !== undefined) next.status = ev.status;
      if (ev.progress !== undefined) next.progress = ev.progress;
      if (ev.imported !== undefined) next.imported = ev.imported;
      if (ev.skipped !== undefined) next.skipped = ev.skipped;
      if (ev.error !== undefined) next.error = ev.error;
      if (ev.message !== undefined) next.message = ev.message;
      return next;
    });
  });

  useEvent('job-updated', (ev) => {
    setActive((a) => {
      if (a === undefined || ev.jobId !== a.jobId) return a;
      const next: ActiveImport = { ...a };
      if (ev.status !== undefined) next.status = ev.status;
      if (ev.progress !== undefined) next.progress = ev.progress;
      if (ev.error !== undefined) next.error = ev.error;
      return next;
    });
  });

  const finished = active !== undefined && (active.status === 'done' || active.status === 'failed' || active.status === 'cancelled');

  // Poll the job as a fallback while it runs; refresh profiles when it finishes.
  useEffect(() => {
    if (active === undefined) return;
    if (finished) {
      void loadProfiles();
      return;
    }
    pollTimer.current = window.setInterval(() => {
      api.importJob(active.jobId).then(applyJob).catch(() => undefined);
    }, 2000);
    return () => {
      if (pollTimer.current !== undefined) window.clearInterval(pollTimer.current);
    };
  }, [active, finished, applyJob, loadProfiles]);

  const start = async (req: ImportRequest) => {
    setStarting(true);
    setSubmitError(undefined);
    try {
      const { jobId } = await api.startImport(req);
      setActive({
        jobId,
        username: req.username.toLowerCase(),
        mode: req.mode,
        status: 'queued',
        progress: 0,
        imported: 0,
        skipped: 0,
      });
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const u = username.trim().toLowerCase();
    if (u === '') {
      setSubmitError('Enter a chess.com username.');
      return;
    }
    const req: ImportRequest = { username: u, mode };
    if (mode === 'latest') req.count = Math.max(1, Math.floor(count));
    if (autoAnalyze) req.autoAnalyzeLatest = DEFAULT_AUTO_ANALYZE;
    void start(req);
  };

  const sync = (p: Profile) => void start({ username: p.username, mode: 'all' });

  const running = active !== undefined && !finished;

  return (
    <div>
      <div className="page-header">
        <h1>Import games</h1>
      </div>

      <div className="card">
        <form onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="username">chess.com username</label>
            <input
              id="username"
              type="text"
              value={username}
              placeholder="e.g. hikaru"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setUsername(e.target.value)}
              disabled={running}
            />
          </div>

          <div className="field">
            <label>Mode</label>
            <div className="inline" style={{ gap: 20, flexWrap: 'wrap' }}>
              <span className="inline">
                <input
                  id="mode-latest"
                  type="radio"
                  name="mode"
                  checked={mode === 'latest'}
                  onChange={() => setMode('latest')}
                  disabled={running}
                />
                <label htmlFor="mode-latest">Latest</label>
                <input
                  type="number"
                  min={1}
                  max={5000}
                  value={count}
                  style={{ width: 80 }}
                  onChange={(e) => setCount(Number(e.target.value) || 1)}
                  disabled={running || mode !== 'latest'}
                  aria-label="Number of latest games"
                />
                <span className="muted small">games</span>
              </span>
              <span className="inline">
                <input
                  id="mode-all"
                  type="radio"
                  name="mode"
                  checked={mode === 'all'}
                  onChange={() => setMode('all')}
                  disabled={running}
                />
                <label htmlFor="mode-all">All games (every monthly archive)</label>
              </span>
            </div>
          </div>

          <div className="field">
            <span className="inline">
              <input
                id="auto"
                type="checkbox"
                checked={autoAnalyze}
                onChange={(e) => setAutoAnalyze(e.target.checked)}
                disabled={running}
              />
              <label htmlFor="auto">Auto-analyze the latest {DEFAULT_AUTO_ANALYZE} games after import</label>
            </span>
          </div>

          {submitError !== undefined && <div className="alert error">{submitError}</div>}

          <button className="btn primary" type="submit" disabled={starting || running}>
            {starting ? 'Starting…' : 'Start import'}
          </button>
        </form>

        {active !== undefined && (
          <div style={{ marginTop: 18 }}>
            <div className="inline" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span>
                <b>{active.username}</b> · {active.mode === 'all' ? 'all games' : 'latest games'} ·{' '}
                <span className={`badge ${active.status === 'done' ? 'ok' : active.status === 'failed' ? 'failed' : 'running'}`}>
                  {active.status}
                </span>
              </span>
              <span className="muted small">
                {active.imported} imported · {active.skipped} skipped
              </span>
            </div>
            <div className={`progress${running && active.progress === 0 ? ' indeterminate' : ''}`}>
              <span style={{ width: `${Math.round(Math.min(1, active.progress) * 100)}%` }} />
            </div>
            {active.message !== undefined && <div className="small muted" style={{ marginTop: 6 }}>{active.message}</div>}
            {active.error !== undefined && <div className="alert error">{active.error}</div>}
            {active.status === 'done' && (
              <div className="alert success">
                Import finished. <Link to={`/games?profile=${encodeURIComponent(active.username)}`}>View games</Link>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Profiles</h2>
        {profilesError !== undefined && <div className="alert error">{profilesError}</div>}
        {profiles.length === 0 ? (
          <div className="dim small">No profiles imported yet.</div>
        ) : (
          <div className="profile-list">
            {profiles.map((p) => (
              <div className="profile-item" key={p.username}>
                <span className="u">{p.username}</span>
                <span className="meta">
                  {p.gameCount} game{p.gameCount === 1 ? '' : 's'} · {formatSync(p.lastSync)}
                </span>
                <span className="actions">
                  <Link className="btn small" to={`/games?profile=${encodeURIComponent(p.username)}`}>
                    Games
                  </Link>
                  <button className="btn small" disabled={running || starting} onClick={() => sync(p)}>
                    Sync
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
