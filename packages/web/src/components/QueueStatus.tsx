import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { AnalysisJob } from '@chess-analyzer/core';
import { api } from '../api/client';
import { useEvent, useEventsConnected } from '../hooks/useEvents';

interface QueueCounts {
  queued: number;
  running: number;
  failed: number;
}

/** Sidebar widget: SSE connection state plus queued/running analysis jobs. */
export function QueueStatus(): JSX.Element {
  const connected = useEventsConnected();
  const [counts, setCounts] = useState<QueueCounts>({ queued: 0, running: 0, failed: 0 });
  const [running, setRunning] = useState<{ gameId: string; progress: number } | undefined>();
  const [error, setError] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const [queued, runningJobs, failed] = await Promise.all([
        api.jobs('queued'),
        api.jobs('running'),
        api.jobs('failed'),
      ]);
      setCounts({ queued: queued.length, running: runningJobs.length, failed: failed.length });
      const first: AnalysisJob | undefined = runningJobs[0];
      setRunning(
        first === undefined ? undefined : { gameId: first.gameId, progress: first.progress },
      );
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  // Debounced refresh so a burst of job-updated events costs one request.
  const scheduleRefresh = useCallback(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      void refresh();
    }, 250);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    // Periodic fallback in case the event stream is down.
    const id = window.setInterval(() => void refresh(), 15000);
    return () => {
      window.clearInterval(id);
      if (timer.current !== undefined) window.clearTimeout(timer.current);
    };
  }, [refresh]);

  useEvent('job-updated', () => scheduleRefresh());
  useEvent('analysis-progress', (ev) => {
    setRunning({ gameId: ev.gameId, progress: ev.progress });
  });

  const idle = counts.queued === 0 && counts.running === 0;

  return (
    <div className="queue-status">
      <div className="row">
        <span>Queue</span>
        <span className="inline" title={connected ? 'Live updates connected' : 'Live updates disconnected'}>
          <span className={`dot${connected ? ' on' : ''}`} />
          <span className="small">{connected ? 'live' : 'offline'}</span>
        </span>
      </div>
      {error ? (
        <div className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>
          API unreachable
        </div>
      ) : idle ? (
        <div className="counts">
          <span className="dim">Idle</span>
          {counts.failed > 0 && (
            <span className="failed">
              <b>{counts.failed}</b> failed
            </span>
          )}
        </div>
      ) : (
        <>
          <div className="counts">
            <span>
              <b>{counts.running}</b> running
            </span>
            <span>
              <b>{counts.queued}</b> queued
            </span>
            {counts.failed > 0 && (
              <span className="failed">
                <b>{counts.failed}</b> failed
              </span>
            )}
          </div>
          {running !== undefined && counts.running > 0 && (
            <div className="bar" title={`Analysing game ${running.gameId}`}>
              <div className="progress">
                <span style={{ width: `${Math.round(running.progress * 100)}%` }} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
