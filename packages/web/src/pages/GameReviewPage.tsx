import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Color, EngineScore, GameAnalysis, GameRecord, MoveAnalysis } from '@chess-analyzer/core';
import { api, errorMessage, type GameDetail } from '../api/client';
import { useEvent } from '../hooks/useEvents';
import { useKeyboardNav } from '../hooks/useKeyboardNav';
import { Board, type BoardArrow } from '../components/Board';
import { EvalBar } from '../components/EvalBar';
import { EvalGraph } from '../components/EvalGraph';
import { KeyMoments } from '../components/KeyMoments';
import { MoveList, type MoveListItem } from '../components/MoveList';
import { PlayerPanel } from '../components/PlayerPanel';
import { ClassificationIcon, IconChevron, IconFlip } from '../icons';
import { CLASSIFICATION_COLORS, classificationPhrase } from '../lib/classification';
import {
  parsePgnPlies,
  pgnHeaders,
  plyOffsetFromFen,
  sanLineToText,
  START_FEN,
  turnFromFen,
  uciToKeys,
  type Ply,
} from '../lib/chess';
import { formatScore } from '../lib/eval';

interface AnalyzeState {
  jobId: string | undefined;
  progress: number;
  ply?: number;
  totalPlies?: number;
  error?: string;
}

function pliesFromAnalysis(analysis: GameAnalysis): Ply[] {
  return analysis.moves.map((m) => ({
    ply: m.ply,
    color: m.color,
    san: m.san,
    uci: m.uci,
    fenBefore: m.fenBefore,
    fenAfter: m.fenAfter,
  }));
}

function profileColor(game: GameRecord): Color {
  return game.black.username.toLowerCase() === game.profileUsername.toLowerCase() ? 'b' : 'w';
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

export function GameReviewPage(): JSX.Element {
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const viewAs = searchParams.get('profile') ?? undefined;
  const [detail, setDetail] = useState<GameDetail | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [ply, setPly] = useState(0);
  const [orientation, setOrientation] = useState<Color>('w');
  const [analyzing, setAnalyzing] = useState<AnalyzeState | undefined>();
  const lastAnalyzedAt = useRef<string | undefined>(undefined);

  const load = useCallback(async (): Promise<GameDetail | undefined> => {
    try {
      const d = await api.game(id, viewAs);
      setDetail(d);
      setLoadError(undefined);
      return d;
    } catch (err) {
      setLoadError(errorMessage(err));
      return undefined;
    }
  }, [id, viewAs]);

  // Initial load; orient the board from the profile's side.
  useEffect(() => {
    setDetail(undefined);
    setPly(0);
    setAnalyzing(undefined);
    void load().then((d) => {
      if (d !== undefined) {
        setOrientation(profileColor(d.game));
        lastAnalyzedAt.current = d.analysis?.analyzedAt;
      }
    });
  }, [load]);

  const game = detail?.game;
  const analysis = detail?.analysis;

  const plies = useMemo<Ply[]>(() => {
    if (game === undefined) return [];
    try {
      return parsePgnPlies(game.pgn);
    } catch {
      return analysis !== undefined ? pliesFromAnalysis(analysis) : [];
    }
  }, [game, analysis]);

  const headers = useMemo(() => (game === undefined ? {} : pgnHeaders(game.pgn)), [game]);
  // Non-zero only for games that start from a FEN (move numbers and the white/black column).
  const plyOffset = useMemo(() => plyOffsetFromFen(plies[0]?.fenBefore ?? START_FEN), [plies]);

  const analysisByPly = useMemo(() => {
    const map = new Map<number, MoveAnalysis>();
    if (analysis !== undefined) for (const m of analysis.moves) map.set(m.ply, m);
    return map;
  }, [analysis]);

  const maxPly = plies.length;
  const clampPly = useCallback((p: number) => Math.max(0, Math.min(maxPly, p)), [maxPly]);
  const goTo = useCallback((p: number) => setPly(clampPly(p)), [clampPly]);

  useKeyboardNav({
    prev: () => setPly((p) => clampPly(p - 1)),
    next: () => setPly((p) => clampPly(p + 1)),
    first: () => setPly(0),
    last: () => setPly(maxPly),
    flip: () => setOrientation((o) => (o === 'w' ? 'b' : 'w')),
  });

  // ---------- analysis job tracking ----------

  const finishAnalysis = useCallback(
    async (error?: string) => {
      if (error !== undefined) {
        setAnalyzing((s) => (s === undefined ? s : { ...s, error }));
        return;
      }
      const d = await load();
      if (d?.analysis !== undefined) {
        lastAnalyzedAt.current = d.analysis.analyzedAt;
        setAnalyzing(undefined);
      }
    },
    [load],
  );

  useEvent('analysis-progress', (ev) => {
    if (ev.gameId !== id) return;
    setAnalyzing((s) => ({
      jobId: s?.jobId ?? (ev.jobId !== '' ? ev.jobId : undefined),
      progress: ev.progress,
      ...(ev.ply !== undefined ? { ply: ev.ply } : {}),
      ...(ev.totalPlies !== undefined ? { totalPlies: ev.totalPlies } : {}),
    }));
    if (ev.status === 'done') void finishAnalysis();
    if (ev.status === 'failed') void finishAnalysis('Analysis failed');
  });

  useEvent('job-updated', (ev) => {
    if (analyzing === undefined) return;
    const mine = ev.gameId === id || (ev.jobId !== '' && ev.jobId === analyzing.jobId);
    if (!mine) return;
    if (ev.status === 'done') void finishAnalysis();
    else if (ev.status === 'failed') void finishAnalysis(ev.error ?? 'Analysis failed');
    else if (ev.status === 'cancelled') setAnalyzing(undefined);
    else if (ev.progress !== undefined) {
      setAnalyzing((s) => (s === undefined ? s : { ...s, progress: ev.progress ?? s.progress }));
    }
  });

  // Polling fallback while a job is running, in case the event stream drops.
  useEffect(() => {
    if (analyzing === undefined || analyzing.error !== undefined) return;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const d = await api.game(id, viewAs);
          if (d.analysis !== undefined && d.analysis.analyzedAt !== lastAnalyzedAt.current) {
            lastAnalyzedAt.current = d.analysis.analyzedAt;
            setDetail(d);
            setAnalyzing(undefined);
          }
        } catch {
          /* keep waiting */
        }
      })();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [analyzing, id, viewAs]);

  const startAnalysis = async () => {
    setAnalyzing({ jobId: undefined, progress: 0 });
    try {
      const { jobId } = await api.analyzeGame(id);
      setAnalyzing((s) => ({ jobId, progress: s?.progress ?? 0 }));
    } catch (err) {
      setAnalyzing({ jobId: undefined, progress: 0, error: errorMessage(err) });
    }
  };

  // ---------- derived view state ----------

  const currentPly = clampPly(ply);
  const currentMove = currentPly > 0 ? plies[currentPly - 1] : undefined;
  const currentAnalysis = currentPly > 0 ? analysisByPly.get(currentPly) : undefined;
  const nextAnalysis = analysisByPly.get(currentPly + 1);

  const fen = currentMove?.fenAfter ?? plies[0]?.fenBefore ?? START_FEN;
  const sideToMove = turnFromFen(fen);
  const lastMove = currentMove !== undefined ? uciToKeys(currentMove.uci) : undefined;

  const score: EngineScore | undefined =
    currentAnalysis?.evalAfter ?? (currentPly === 0 ? nextAnalysis?.evalBefore : undefined);

  const playedIsBest =
    currentAnalysis !== undefined && currentAnalysis.uci === currentAnalysis.bestMove.uci;

  const arrows = useMemo<BoardArrow[]>(() => {
    const out: BoardArrow[] = [];
    if (currentAnalysis !== undefined && !playedIsBest) {
      // The move that should have been played instead, in the played move's classification colour.
      const keys = uciToKeys(currentAnalysis.bestMove.uci);
      if (keys !== undefined) out.push({ from: keys[0], to: keys[1], brush: currentAnalysis.classification });
    } else if (nextAnalysis !== undefined) {
      // Played move was best (or start of game): show the engine's choice in this position.
      const keys = uciToKeys(nextAnalysis.bestMove.uci);
      if (keys !== undefined) out.push({ from: keys[0], to: keys[1], brush: 'best' });
    }
    return out;
  }, [currentAnalysis, nextAnalysis, playedIsBest]);

  const moveListItems = useMemo<MoveListItem[]>(
    () =>
      plies.map((p) => ({
        ply: p.ply,
        san: p.san,
        classification: analysisByPly.get(p.ply)?.classification,
      })),
    [plies, analysisByPly],
  );

  // ---------- render ----------

  if (loadError !== undefined) {
    return (
      <div>
        <div className="page-header">
          <h1>Game Review</h1>
          <Link to="/games" className="btn small">
            Back to games
          </Link>
        </div>
        <div className="alert error">{loadError}</div>
      </div>
    );
  }

  if (game === undefined) {
    return <div className="empty">Loading game…</div>;
  }

  // Core reports { eco: '', name: 'Unknown' } when no book line matched; fall back to what
  // chess.com said about the opening in that case.
  const bookName = analysis?.opening.name;
  const openingName = bookName !== undefined && bookName !== '' && bookName !== 'Unknown' ? bookName : (game.openingName ?? headers.Opening);
  const eco = analysis?.opening.eco || game.eco || headers.ECO;
  const whiteRating = game.white.rating > 0 ? game.white.rating : undefined;
  const blackRating = game.black.rating > 0 ? game.black.rating : undefined;
  const topColor: Color = orientation === 'w' ? 'b' : 'w';
  const bottomColor: Color = orientation;
  const playerFor = (c: Color) => (c === 'w' ? game.white : game.black);
  const ratingFor = (c: Color) => (c === 'w' ? whiteRating : blackRating);
  const summaryFor = (c: Color) => (c === 'w' ? analysis?.white : analysis?.black);

  const bestWas =
    currentAnalysis === undefined
      ? undefined
      : playedIsBest
        ? `Best line: ${sanLineToText(currentAnalysis.bestLine, currentPly, plyOffset)}`
        : `Best was ${currentAnalysis.bestMove.san}: ${sanLineToText(currentAnalysis.bestLine, currentPly, plyOffset)}`;

  return (
    <div>
      <div className="page-header">
        <div className="review-header">
          <div className="title">
            {openingName ?? 'Unknown opening'}
            {eco !== undefined && (
              <span className="muted" style={{ marginLeft: 8, fontWeight: 400 }}>
                {eco}
              </span>
            )}
          </div>
          <div className="meta">
            {game.white.username} ({whiteRating ?? '?'}) vs {game.black.username} ({blackRating ?? '?'}) ·{' '}
            {game.result} · {game.timeClass} {game.timeControl} · {formatDate(game.endTime)} ·{' '}
            <a href={game.url} target="_blank" rel="noreferrer">
              chess.com
            </a>
          </div>
        </div>
        <Link to="/games" className="btn small">
          Back to games
        </Link>
      </div>

      <div className="review">
        <div>
          <div className="board-wrap">
            <EvalBar score={score} orientation={orientation} sideToMove={sideToMove} />
            <div className="board-column">
              <div className="small muted inline" style={{ justifyContent: 'space-between' }}>
                <span>
                  <span className={`color-swatch ${topColor}`} /> {playerFor(topColor).username}{' '}
                  {ratingFor(topColor) !== undefined && `(${ratingFor(topColor)})`}
                </span>
                {score !== undefined && <span className="mono">{formatScore(score, sideToMove)}</span>}
              </div>
              <Board fen={fen} orientation={orientation} lastMove={lastMove} arrows={arrows} />
              <div className="small muted inline" style={{ justifyContent: 'space-between' }}>
                <span>
                  <span className={`color-swatch ${bottomColor}`} /> {playerFor(bottomColor).username}{' '}
                  {ratingFor(bottomColor) !== undefined && `(${ratingFor(bottomColor)})`}
                </span>
                <span>
                  {currentPly} / {maxPly}
                </span>
              </div>
              <div className="board-controls">
                <button className="btn icon" onClick={() => goTo(0)} disabled={currentPly === 0} title="First (Home)">
                  <IconChevron dir="first" />
                </button>
                <button className="btn icon" onClick={() => goTo(currentPly - 1)} disabled={currentPly === 0} title="Previous (←)">
                  <IconChevron dir="left" />
                </button>
                <button className="btn icon" onClick={() => goTo(currentPly + 1)} disabled={currentPly >= maxPly} title="Next (→)">
                  <IconChevron dir="right" />
                </button>
                <button className="btn icon" onClick={() => goTo(maxPly)} disabled={currentPly >= maxPly} title="Last (End)">
                  <IconChevron dir="last" />
                </button>
                <button
                  className="btn icon"
                  onClick={() => setOrientation((o) => (o === 'w' ? 'b' : 'w'))}
                  title="Flip board (F)"
                >
                  <IconFlip />
                </button>
              </div>
            </div>
          </div>

          {analysis !== undefined && (
            <div className="card" style={{ marginTop: 14 }}>
              <h3>Evaluation</h3>
              <EvalGraph
                moves={analysis.moves}
                keyMoments={analysis.keyMoments}
                currentPly={currentPly}
                onSelectPly={goTo}
                plyOffset={plyOffset}
              />
            </div>
          )}
        </div>

        <div className="review-side">
          <div className="card analyze-box">
            {analysis === undefined && analyzing === undefined && (
              <>
                <div className="muted small">This game has not been analysed yet.</div>
                <div>
                  <button className="btn primary" onClick={() => void startAnalysis()}>
                    Analyze
                  </button>
                </div>
              </>
            )}
            {analyzing !== undefined && (
              <>
                <div className="inline" style={{ justifyContent: 'space-between' }}>
                  <span>
                    {analyzing.error !== undefined
                      ? 'Analysis failed'
                      : analyzing.jobId === undefined
                        ? 'Starting analysis…'
                        : `Analysing… ${Math.round(analyzing.progress * 100)}%`}
                  </span>
                  {analyzing.ply !== undefined && analyzing.totalPlies !== undefined && (
                    <span className="muted small">
                      ply {analyzing.ply} / {analyzing.totalPlies}
                    </span>
                  )}
                </div>
                {analyzing.error === undefined ? (
                  <div className={`progress${analyzing.progress === 0 ? ' indeterminate' : ''}`}>
                    <span style={{ width: `${Math.round(analyzing.progress * 100)}%` }} />
                  </div>
                ) : (
                  <>
                    <div className="alert error" style={{ margin: 0 }}>
                      {analyzing.error}
                    </div>
                    <div className="btn-group">
                      <button className="btn primary" onClick={() => void startAnalysis()}>
                        Retry
                      </button>
                      <button className="btn" onClick={() => setAnalyzing(undefined)}>
                        Dismiss
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
            {analysis !== undefined && analyzing === undefined && (
              <>
                {currentAnalysis !== undefined ? (
                  <div className="move-callout">
                    <ClassificationIcon classification={currentAnalysis.classification} size={22} />
                    <span style={{ color: CLASSIFICATION_COLORS[currentAnalysis.classification] }}>
                      {classificationPhrase(currentAnalysis.san, currentAnalysis.classification)}
                    </span>
                  </div>
                ) : (
                  <div className="move-callout">
                    <span className="muted">Start position</span>
                  </div>
                )}
                {bestWas !== undefined && <div className="best-line mono small muted">{bestWas}</div>}
                {currentAnalysis === undefined && nextAnalysis !== undefined && (
                  <div className="best-line mono small muted">
                    Best: {sanLineToText(nextAnalysis.bestLine, currentPly + 1, plyOffset)}
                  </div>
                )}
                <div className="inline small dim" style={{ justifyContent: 'space-between' }}>
                  <span>
                    Analysed {new Date(analysis.analyzedAt).toLocaleString()} · depth {analysis.settings.depth}
                  </span>
                  <button className="btn small" onClick={() => void startAnalysis()}>
                    Re-analyze
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="players">
            <PlayerPanel
              color="w"
              username={game.white.username}
              rating={whiteRating}
              summary={summaryFor('w')}
            />
            <PlayerPanel
              color="b"
              username={game.black.username}
              rating={blackRating}
              summary={summaryFor('b')}
            />
          </div>

          <div className="card" style={{ padding: 8 }}>
            <MoveList moves={moveListItems} currentPly={currentPly} onSelectPly={goTo} plyOffset={plyOffset} />
          </div>

          {analysis !== undefined && (
            <div className="card">
              <h3>Key moments</h3>
              <KeyMoments moves={analysis.moves} keyMoments={analysis.keyMoments} onSelectPly={goTo} plyOffset={plyOffset} />
            </div>
          )}

          <div className="small dim">
            <span className="kbd">←</span> <span className="kbd">→</span> navigate · <span className="kbd">Home</span>{' '}
            <span className="kbd">End</span> jump · <span className="kbd">F</span> flip
          </div>
        </div>
      </div>
    </div>
  );
}
