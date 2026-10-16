/**
 * Job queue: a single worker runs import and analysis jobs one at a time, persisting state in
 * the `jobs` table and broadcasting progress over SSE. See docs/ARCHITECTURE.md ("Analysis queue").
 */
import {
  analyzeGame as coreAnalyzeGame,
  settingsKey as coreSettingsKey,
  type AnalysisJob,
  type AnalysisSettings,
  type GameAnalysis,
  type ImportJob,
  type JobStatus,
  type OpeningBook,
  type TimeClass,
} from '@chess-analyzer/core';
import type { Db } from '../db/index.js';
import type { JobRow } from '../db/schema.js';
import type { EventHub } from '../events.js';
import { GameRepository } from '../games.js';
import { ChesscomClient, importChesscomGames, errorMessage, type ImportOptions, type ImportResult } from '../import/chesscom.js';
import type { SettingsService } from '../settings.js';
import { EngineManager, type EngineLease } from './engine.js';
import {
  JobStore,
  parsePayload,
  toAnalysisJob,
  toImportJob,
  type AnalysisJobPayload,
  type ImportJobPayload,
  type JobKind,
} from './jobs.js';
import { SqlitePositionCache } from './positionCache.js';

export type AnalyzeGameFn = typeof coreAnalyzeGame;
export type ImportGamesFn = (opts: ImportOptions) => Promise<ImportResult>;
export type SettingsKeyFn = (settings: AnalysisSettings, engineName: string) => string;

export interface QueueLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface JobQueueOptions {
  db: Db;
  settings: SettingsService;
  events: EventHub;
  engine: EngineManager;
  book: OpeningBook;
  analyzeGame?: AnalyzeGameFn;
  settingsKey?: SettingsKeyFn;
  importGames?: ImportGamesFn;
  chesscomClient?: ChesscomClient;
  openingNameFromEcoUrl?: (url: string) => string;
  now?: () => Date;
  log?: QueueLogger;
  /** Minimum progress delta before persisting / broadcasting progress (default 0.01). */
  progressStep?: number;
}

export class JobCancelledError extends Error {
  constructor(message = 'Job cancelled') {
    super(message);
    this.name = 'JobCancelledError';
  }
}

interface RunningJob {
  row: JobRow;
  abort: AbortController;
}

export class JobQueue {
  readonly store: JobStore;
  readonly cache: SqlitePositionCache;
  private readonly games: GameRepository;
  private readonly analyzeGame: AnalyzeGameFn;
  private readonly settingsKey: SettingsKeyFn;
  private readonly importGames: ImportGamesFn;
  private readonly now: () => Date;
  private readonly progressStep: number;
  private current: RunningJob | undefined;
  private draining: Promise<void> | undefined;
  /** The worker only runs between start() and stop(). */
  private started = false;

  constructor(private readonly opts: JobQueueOptions) {
    this.now = opts.now ?? (() => new Date());
    this.store = new JobStore(opts.db, this.now);
    this.cache = new SqlitePositionCache(opts.db, this.now);
    this.games = new GameRepository(opts.db);
    this.analyzeGame = opts.analyzeGame ?? coreAnalyzeGame;
    this.settingsKey = opts.settingsKey ?? coreSettingsKey;
    this.importGames = opts.importGames ?? importChesscomGames;
    this.progressStep = opts.progressStep ?? 0.01;
  }

  /** Re-queue jobs left running by a previous process and start the worker. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const reset = this.store.requeueRunning();
    if (reset > 0) this.opts.log?.info(`re-queued ${reset} interrupted job(s)`);
    this.kick();
  }

  /** Abort the running job, wait for the worker to settle and quit the engine. */
  async stop(): Promise<void> {
    if (!this.started) {
      await this.opts.engine.shutdown();
      return;
    }
    this.started = false;
    this.current?.abort.abort(new JobCancelledError('Server shutting down'));
    this.opts.engine.stopSearch();
    if (this.draining) await this.draining;
    // The interrupted job (if any) goes back to the queue so it resumes on next boot.
    await this.opts.engine.shutdown();
  }

  get isIdle(): boolean {
    return this.current === undefined;
  }

  enqueueImport(payload: ImportJobPayload): ImportJob {
    const row = this.store.insert('import', { ...payload, username: payload.username.trim().toLowerCase(), imported: 0, skipped: 0 });
    this.emitJobUpdated(row);
    this.kick();
    return toImportJob(row);
  }

  /** Enqueue an analysis for a game; returns the existing active job when one is pending. */
  enqueueAnalysis(gameId: string): AnalysisJob {
    const active = this.store.findActiveAnalysisForGame(gameId);
    if (active) return toAnalysisJob(active);
    const row = this.store.insert('analysis', { gameId } satisfies AnalysisJobPayload);
    this.emitJobUpdated(row);
    this.kick();
    return toAnalysisJob(row);
  }

  getImportJob(id: string): ImportJob | undefined {
    const row = this.store.get(id);
    return row && row.kind === 'import' ? toImportJob(row) : undefined;
  }

  getAnalysisJob(id: string): AnalysisJob | undefined {
    const row = this.store.get(id);
    return row && row.kind === 'analysis' ? toAnalysisJob(row) : undefined;
  }

  getJob(id: string): JobRow | undefined {
    return this.store.get(id);
  }

  listAnalysisJobs(status?: JobStatus, limit = 500): AnalysisJob[] {
    return this.store.list({ kind: 'analysis', status, limit }).map(toAnalysisJob);
  }

  listImportJobs(status?: JobStatus, limit = 100): ImportJob[] {
    return this.store.list({ kind: 'import', status, limit }).map(toImportJob);
  }

  /** Cancel a queued or running job. Returns false when the job is unknown or already finished. */
  cancel(id: string): boolean {
    const row = this.store.get(id);
    if (!row) return false;
    if (row.status === 'queued') {
      const updated = this.store.setStatus(id, 'cancelled');
      if (updated) this.emitJobUpdated(updated);
      return true;
    }
    if (row.status === 'running' && this.current?.row.id === id) {
      this.current.abort.abort(new JobCancelledError());
      this.opts.engine.stopSearch();
      return true;
    }
    return false;
  }

  /**
   * Settings key for the current settings, or undefined while the engine name is unknown
   * (the binary has never been started, so no analysis can exist for it yet).
   */
  currentSettingsKey(): string | undefined {
    const settings = this.opts.settings.getAnalysis();
    const engineName = this.opts.engine.engineNameFor(settings);
    return engineName === undefined ? undefined : this.settingsKey(settings, engineName);
  }

  // ---- worker -------------------------------------------------------------------------

  private kick(): void {
    if (!this.started || this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (this.started && this.store.nextQueued()) this.kick();
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (!this.started) return;
      const row = this.store.nextQueued();
      if (!row) return;
      await this.runJob(row);
    }
  }

  private async runJob(row: JobRow): Promise<void> {
    const abort = new AbortController();
    this.current = { row, abort };
    const started = this.store.setStatus(row.id, 'running', { progress: 0, error: null }) ?? row;
    this.emitJobUpdated(started);
    try {
      if (row.kind === 'analysis') await this.runAnalysis(started, abort.signal);
      else if (row.kind === 'import') await this.runImport(started, abort.signal);
      else throw new Error(`Unknown job kind "${row.kind as JobKind}"`);
      const done = this.store.setStatus(row.id, 'done', { progress: 1 });
      if (done) this.emitJobUpdated(done);
    } catch (err) {
      const cancelled = abort.signal.aborted || err instanceof JobCancelledError;
      if (cancelled && !this.started) {
        // Interrupted by shutdown: leave it for the next boot.
        const requeued = this.store.setStatus(row.id, 'queued', { progress: 0 });
        if (requeued) this.emitJobUpdated(requeued);
      } else if (cancelled) {
        const cancelledRow = this.store.setStatus(row.id, 'cancelled');
        if (cancelledRow) this.emitJobUpdated(cancelledRow);
      } else {
        const message = errorMessage(err);
        this.opts.log?.error(`job ${row.id} (${row.kind}) failed: ${message}`);
        const failed = this.store.setStatus(row.id, 'failed', { error: message });
        if (failed) this.emitJobUpdated(failed);
        if (row.kind === 'analysis') {
          // The engine may be in a bad state (crash, stuck search); start fresh next time.
          await this.opts.engine.shutdown();
        }
      }
    } finally {
      this.current = undefined;
    }
  }

  private async runAnalysis(row: JobRow, signal: AbortSignal): Promise<GameAnalysis> {
    const { gameId } = parsePayload<AnalysisJobPayload>(row);
    const game = this.games.getRow(gameId);
    if (!game) throw new Error(`Game ${gameId} not found`);
    const settings = this.opts.settings.getAnalysis();
    const thresholds = this.opts.settings.getThresholds();
    // Hold the engine for the whole job: a settings change (or /api/health) must not restart it.
    const lease = await this.opts.engine.lease(settings);
    try {
      return await this.analyseWithEngine(row, gameId, game, settings, thresholds, lease.engine, signal);
    } finally {
      lease.release();
    }
  }

  private async analyseWithEngine(
    row: JobRow,
    gameId: string,
    game: NonNullable<ReturnType<GameRepository['getRow']>>,
    settings: AnalysisSettings,
    thresholds: ReturnType<SettingsService['getThresholds']>,
    engine: EngineLease['engine'],
    signal: AbortSignal,
  ): Promise<GameAnalysis> {
    if (signal.aborted) throw new JobCancelledError();

    let lastReported = 0;
    const onProgress = (progress: number) => {
      if (progress < 1 && progress - lastReported < this.progressStep) return;
      lastReported = progress;
      this.store.setProgress(row.id, progress);
      this.opts.events.broadcast('analysis-progress', { jobId: row.id, gameId, progress });
    };

    const analysis = await this.analyzeGame({
      gameId,
      pgn: game.pgn,
      timeClass: game.timeClass as TimeClass,
      whiteUsername: game.whiteUsername,
      blackUsername: game.blackUsername,
      whiteRating: game.whiteRating,
      blackRating: game.blackRating,
      engine,
      book: this.opts.book,
      settings,
      thresholds,
      cache: this.cache,
      onProgress,
      signal,
    });
    if (signal.aborted) throw new JobCancelledError();
    this.games.saveAnalysis(analysis);
    this.opts.events.broadcast('analysis-progress', { jobId: row.id, gameId, progress: 1 });
    return analysis;
  }

  private async runImport(row: JobRow, signal: AbortSignal): Promise<ImportResult> {
    const payload = parsePayload<ImportJobPayload>(row);
    const client = this.opts.chesscomClient ?? new ChesscomClient();
    const importOpts: ImportOptions = {
      db: this.opts.db,
      username: payload.username,
      mode: payload.mode,
      client,
      now: this.now,
      signal,
      onProgress: (p) => {
        const updated: ImportJobPayload = { ...payload, imported: p.imported, skipped: p.skipped };
        this.store.setProgress(row.id, p.progress, updated);
        this.opts.events.broadcast('import-progress', {
          jobId: row.id,
          username: payload.username,
          status: 'running',
          progress: p.progress,
          imported: p.imported,
          skipped: p.skipped,
          archivesFetched: p.archivesFetched,
          archivesTotal: p.archivesTotal,
        });
      },
    };
    if (payload.count !== undefined) importOpts.count = payload.count;
    if (this.opts.openingNameFromEcoUrl) importOpts.openingNameFromEcoUrl = this.opts.openingNameFromEcoUrl;

    const result = await this.importGames(importOpts);
    const finalPayload: ImportJobPayload = { ...payload, imported: result.imported, skipped: result.skipped };
    this.store.updatePayload(row.id, finalPayload);
    this.opts.events.broadcast('import-progress', {
      jobId: row.id,
      username: payload.username,
      status: 'done',
      progress: 1,
      imported: result.imported,
      skipped: result.skipped,
    });

    if (payload.autoAnalyzeLatest && payload.autoAnalyzeLatest > 0) {
      const ids = this.games.latestGameIds(result.username, payload.autoAnalyzeLatest, {
        onlyUnanalyzed: true,
        unanalyzedFor: this.currentSettingsKey(),
      });
      for (const id of ids) this.enqueueAnalysis(id);
    }
    return result;
  }

  private emitJobUpdated(row: JobRow): void {
    const job = row.kind === 'import' ? toImportJob(row) : toAnalysisJob(row);
    this.opts.events.broadcast('job-updated', { kind: row.kind, job });
  }
}
