/**
 * Server-sent events from GET /api/events.
 *
 * The contract names three event types (`import-progress`, `analysis-progress`,
 * `job-updated`) but does not pin their payload shapes, so every payload is run
 * through a tolerant normaliser: nested `job` / `payload` objects are flattened and
 * both `jobId` and `id` are accepted for the job identifier.
 */
import type { JobStatus } from '@chess-analyzer/core';

export type EventName = 'import-progress' | 'analysis-progress' | 'job-updated';

export interface ImportProgressEvent {
  jobId: string;
  username?: string;
  mode?: 'all' | 'latest';
  status?: JobStatus;
  /** 0..1 */
  progress?: number;
  imported?: number;
  skipped?: number;
  error?: string;
  message?: string;
}

export interface AnalysisProgressEvent {
  jobId: string;
  gameId: string;
  /** 0..1 */
  progress: number;
  ply?: number;
  totalPlies?: number;
  status?: JobStatus;
}

export interface JobUpdatedEvent {
  jobId: string;
  kind?: 'import' | 'analysis';
  status?: JobStatus;
  gameId?: string;
  username?: string;
  progress?: number;
  error?: string;
}

export interface EventPayloads {
  'import-progress': ImportProgressEvent;
  'analysis-progress': AnalysisProgressEvent;
  'job-updated': JobUpdatedEvent;
}

type Handler<N extends EventName> = (payload: EventPayloads[N]) => void;
type ConnectionHandler = (connected: boolean) => void;

const EVENT_NAMES: readonly EventName[] = ['import-progress', 'analysis-progress', 'job-updated'];

// ---------- normalisation ----------

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Flatten `{ job: {...}, payload: {...}, ...rest }` into one object (outer keys win). */
function flatten(raw: unknown): Obj {
  if (!isObj(raw)) return {};
  const out: Obj = {};
  for (const nested of ['payload', 'job', 'data']) {
    const inner = raw[nested];
    if (isObj(inner)) Object.assign(out, flatten(inner));
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'payload' || k === 'job' || k === 'data') continue;
    out[k] = v;
  }
  return out;
}

function str(o: Obj, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

function num(o: Obj, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

const STATUSES: readonly JobStatus[] = ['queued', 'running', 'done', 'failed', 'cancelled'];

function status(o: Obj): JobStatus | undefined {
  const s = str(o, 'status');
  return s !== undefined && (STATUSES as readonly string[]).includes(s) ? (s as JobStatus) : undefined;
}

/** Progress as 0..1 — accepts 0..1 directly or a {done,total} / {current,total} pair. */
function progress(o: Obj): number | undefined {
  const p = num(o, 'progress');
  if (p !== undefined) return p > 1 ? Math.min(1, p / 100) : Math.max(0, p);
  const done = num(o, 'done', 'current', 'ply', 'completed');
  const total = num(o, 'total', 'totalPlies', 'plies');
  if (done !== undefined && total !== undefined && total > 0) return Math.min(1, done / total);
  return undefined;
}

function mode(o: Obj): 'all' | 'latest' | undefined {
  const m = str(o, 'mode');
  return m === 'all' || m === 'latest' ? m : undefined;
}

function kind(o: Obj): 'import' | 'analysis' | undefined {
  const k = str(o, 'kind', 'type');
  if (k === 'import' || k === 'analysis') return k;
  if (typeof o.gameId === 'string') return 'analysis';
  if (typeof o.username === 'string') return 'import';
  return undefined;
}

export function normaliseImportProgress(raw: unknown): ImportProgressEvent | undefined {
  const o = flatten(raw);
  const jobId = str(o, 'jobId', 'id');
  if (jobId === undefined) return undefined;
  const ev: ImportProgressEvent = { jobId };
  const username = str(o, 'username');
  if (username !== undefined) ev.username = username.toLowerCase();
  const m = mode(o);
  if (m !== undefined) ev.mode = m;
  const st = status(o);
  if (st !== undefined) ev.status = st;
  const p = progress(o);
  if (p !== undefined) ev.progress = p;
  const imported = num(o, 'imported');
  if (imported !== undefined) ev.imported = imported;
  const skipped = num(o, 'skipped');
  if (skipped !== undefined) ev.skipped = skipped;
  const error = str(o, 'error');
  if (error !== undefined) ev.error = error;
  const message = str(o, 'message');
  if (message !== undefined) ev.message = message;
  return ev;
}

export function normaliseAnalysisProgress(raw: unknown): AnalysisProgressEvent | undefined {
  const o = flatten(raw);
  const jobId = str(o, 'jobId', 'id') ?? '';
  const gameId = str(o, 'gameId', 'game_id');
  if (gameId === undefined) return undefined;
  const ev: AnalysisProgressEvent = { jobId, gameId, progress: progress(o) ?? 0 };
  const ply = num(o, 'ply', 'current', 'done');
  if (ply !== undefined) ev.ply = ply;
  const total = num(o, 'totalPlies', 'total', 'plies');
  if (total !== undefined) ev.totalPlies = total;
  const st = status(o);
  if (st !== undefined) ev.status = st;
  return ev;
}

export function normaliseJobUpdated(raw: unknown): JobUpdatedEvent | undefined {
  const o = flatten(raw);
  const jobId = str(o, 'jobId', 'id');
  if (jobId === undefined) return undefined;
  const ev: JobUpdatedEvent = { jobId };
  const k = kind(o);
  if (k !== undefined) ev.kind = k;
  const st = status(o);
  if (st !== undefined) ev.status = st;
  const gameId = str(o, 'gameId', 'game_id');
  if (gameId !== undefined) ev.gameId = gameId;
  const username = str(o, 'username');
  if (username !== undefined) ev.username = username.toLowerCase();
  const p = progress(o);
  if (p !== undefined) ev.progress = p;
  const error = str(o, 'error');
  if (error !== undefined) ev.error = error;
  return ev;
}

function normalise<N extends EventName>(name: N, raw: unknown): EventPayloads[N] | undefined {
  switch (name) {
    case 'import-progress':
      return normaliseImportProgress(raw) as EventPayloads[N] | undefined;
    case 'analysis-progress':
      return normaliseAnalysisProgress(raw) as EventPayloads[N] | undefined;
    case 'job-updated':
      return normaliseJobUpdated(raw) as EventPayloads[N] | undefined;
    default:
      return undefined;
  }
}

// ---------- singleton EventSource ----------

class EventStream {
  private source: EventSource | undefined;
  private readonly handlers = new Map<EventName, Set<Handler<EventName>>>();
  private readonly connectionHandlers = new Set<ConnectionHandler>();
  private connected = false;
  private readonly url: string;

  constructor(url = '/api/events') {
    this.url = url;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Open the stream (idempotent). */
  connect(): void {
    if (this.source !== undefined || typeof EventSource === 'undefined') return;
    const source = new EventSource(this.url);
    this.source = source;
    source.onopen = () => this.setConnected(true);
    source.onerror = () => {
      // EventSource reconnects by itself; just reflect the state.
      this.setConnected(source.readyState === EventSource.OPEN);
    };
    for (const name of EVENT_NAMES) {
      source.addEventListener(name, (ev: MessageEvent<string>) => this.dispatch(name, ev.data));
    }
    // Some servers send untyped messages with a `type` field in the JSON.
    source.onmessage = (ev: MessageEvent<string>) => {
      try {
        const parsed: unknown = JSON.parse(ev.data);
        if (isObj(parsed)) {
          const t = str(parsed, 'type', 'event');
          if (t !== undefined && (EVENT_NAMES as readonly string[]).includes(t)) {
            this.dispatch(t as EventName, ev.data);
          }
        }
      } catch {
        /* ignore malformed */
      }
    };
  }

  close(): void {
    this.source?.close();
    this.source = undefined;
    this.setConnected(false);
  }

  subscribe<N extends EventName>(name: N, handler: Handler<N>): () => void {
    this.connect();
    let set = this.handlers.get(name);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(name, set);
    }
    const h = handler as Handler<EventName>;
    set.add(h);
    return () => {
      set.delete(h);
    };
  }

  onConnection(handler: ConnectionHandler): () => void {
    this.connect();
    this.connectionHandlers.add(handler);
    handler(this.connected);
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  private setConnected(v: boolean): void {
    if (this.connected === v) return;
    this.connected = v;
    for (const h of this.connectionHandlers) h(v);
  }

  private dispatch(name: EventName, data: string): void {
    const set = this.handlers.get(name);
    if (set === undefined || set.size === 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const payload = normalise(name, raw);
    if (payload === undefined) return;
    for (const h of set) {
      try {
        h(payload);
      } catch (err) {
        console.error(`events: handler for ${name} threw`, err);
      }
    }
  }
}

export const events = new EventStream();
