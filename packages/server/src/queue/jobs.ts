/**
 * Persistence helpers for the `jobs` table and conversion to the API job shapes.
 */
import type { AnalysisJob, ImportJob, JobStatus } from '@chess-analyzer/core';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { jobs, type JobRow } from '../db/schema.js';

export type JobKind = 'import' | 'analysis';

export interface ImportJobPayload {
  username: string;
  mode: 'all' | 'latest';
  count?: number;
  autoAnalyzeLatest?: number;
  imported?: number;
  skipped?: number;
}

export interface AnalysisJobPayload {
  gameId: string;
}

export type JobPayload = ImportJobPayload | AnalysisJobPayload;

export const ACTIVE_STATUSES: readonly JobStatus[] = ['queued', 'running'];
export const JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'done', 'failed', 'cancelled'];

export function parsePayload<T extends JobPayload>(row: JobRow): T {
  return JSON.parse(row.payloadJson) as T;
}

export function toAnalysisJob(row: JobRow): AnalysisJob {
  const payload = parsePayload<AnalysisJobPayload>(row);
  const job: AnalysisJob = {
    id: row.id,
    gameId: payload.gameId,
    status: row.status as JobStatus,
    progress: row.progress,
    createdAt: row.createdAt,
  };
  if (row.error) job.error = row.error;
  if (row.startedAt) job.startedAt = row.startedAt;
  if (row.finishedAt) job.finishedAt = row.finishedAt;
  return job;
}

export function toImportJob(row: JobRow): ImportJob {
  const payload = parsePayload<ImportJobPayload>(row);
  const job: ImportJob = {
    id: row.id,
    username: payload.username,
    mode: payload.mode,
    status: row.status as JobStatus,
    progress: row.progress,
    imported: payload.imported ?? 0,
    skipped: payload.skipped ?? 0,
  };
  if (payload.count !== undefined) job.count = payload.count;
  if (row.error) job.error = row.error;
  return job;
}

export class JobStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  insert(kind: JobKind, payload: JobPayload): JobRow {
    const row: JobRow = {
      id: crypto.randomUUID(),
      kind,
      payloadJson: JSON.stringify(payload),
      status: 'queued',
      progress: 0,
      error: null,
      createdAt: this.now().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    this.db.insert(jobs).values(row).run();
    return row;
  }

  get(id: string): JobRow | undefined {
    return this.db.select().from(jobs).where(eq(jobs.id, id)).get();
  }

  /** Oldest queued job, if any. */
  nextQueued(): JobRow | undefined {
    return this.db.select().from(jobs).where(eq(jobs.status, 'queued')).orderBy(asc(jobs.createdAt)).limit(1).get();
  }

  list(filter: { kind?: JobKind; status?: JobStatus; limit?: number } = {}): JobRow[] {
    const conds = [];
    if (filter.kind) conds.push(eq(jobs.kind, filter.kind));
    if (filter.status) conds.push(eq(jobs.status, filter.status));
    const query = this.db
      .select()
      .from(jobs)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(jobs.createdAt));
    return filter.limit ? query.limit(filter.limit).all() : query.all();
  }

  /** Active (queued or running) analysis job for a game, if any. */
  findActiveAnalysisForGame(gameId: string): JobRow | undefined {
    const payloadJson = JSON.stringify({ gameId } satisfies AnalysisJobPayload);
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.kind, 'analysis'), eq(jobs.payloadJson, payloadJson), inArray(jobs.status, [...ACTIVE_STATUSES])))
      .orderBy(asc(jobs.createdAt))
      .limit(1)
      .get();
  }

  setStatus(id: string, status: JobStatus, extra: { error?: string | null; progress?: number } = {}): JobRow | undefined {
    const nowIso = this.now().toISOString();
    const set: Partial<JobRow> = { status };
    if (status === 'running') set.startedAt = nowIso;
    if (status === 'done' || status === 'failed' || status === 'cancelled') set.finishedAt = nowIso;
    if (extra.error !== undefined) set.error = extra.error;
    if (extra.progress !== undefined) set.progress = extra.progress;
    this.db.update(jobs).set(set).where(eq(jobs.id, id)).run();
    return this.get(id);
  }

  setProgress(id: string, progress: number, payload?: JobPayload): void {
    const set: Partial<JobRow> = { progress: Math.max(0, Math.min(1, progress)) };
    if (payload) set.payloadJson = JSON.stringify(payload);
    this.db.update(jobs).set(set).where(eq(jobs.id, id)).run();
  }

  updatePayload(id: string, payload: JobPayload): void {
    this.db.update(jobs).set({ payloadJson: JSON.stringify(payload) }).where(eq(jobs.id, id)).run();
  }

  /** Jobs left 'running' by a previous process are re-queued. Returns how many were reset. */
  requeueRunning(): number {
    const running = this.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, 'running')).all();
    if (running.length === 0) return 0;
    this.db
      .update(jobs)
      .set({ status: 'queued', progress: 0, startedAt: null })
      .where(eq(jobs.status, 'running'))
      .run();
    return running.length;
  }
}
