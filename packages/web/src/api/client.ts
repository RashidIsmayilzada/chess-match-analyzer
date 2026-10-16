import type {
  AnalysisJob,
  AnalysisSettings,
  GameAnalysis,
  GameRecord,
  ImportJob,
  Profile,
  Thresholds,
  TimeClass,
} from '@chess-analyzer/core';

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

const BASE = '/api';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { Accept: 'application/json' },
  };
  if (body !== undefined) {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let data: unknown = undefined;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const message =
      data !== null && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
        ? data.message
        : data !== null && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
          ? data.error
          : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, message, data);
  }
  return data as T;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// ---------- request / response shapes not in core ----------

export interface ImportRequest {
  username: string;
  mode: 'all' | 'latest';
  count?: number;
  autoAnalyzeLatest?: number;
}

export interface GamesQuery {
  profile?: string;
  timeClass?: TimeClass;
  analyzed?: boolean;
  page?: number;
  pageSize?: number;
}

/**
 * Row of GET /games. `accuracy` is not part of the GameRecord contract; the UI shows it
 * when the server includes it and otherwise lazily loads it from GET /games/:id.
 */
export type GameListItem = GameRecord & {
  accuracy?: { white: number; black: number };
};

export interface GamesResponse {
  items: GameListItem[];
  total: number;
}

export interface GameDetail {
  game: GameRecord;
  analysis?: GameAnalysis;
}

export interface SettingsResponse {
  analysis: AnalysisSettings;
  thresholds: Thresholds;
}

/** Deep-partial PUT /settings body. `movetimeMs: null` clears a previously set movetime. */
export interface SettingsUpdate {
  analysis?: Partial<Omit<AnalysisSettings, 'movetimeMs'>> & { movetimeMs?: number | null };
  thresholds?: Thresholds;
}

export interface OpeningLine {
  eco: string;
  name: string;
  pgn: string;
}

export interface HealthResponse {
  ok: boolean;
  engine: string;
}

// ---------- client ----------

export const api = {
  profiles: () => request<Profile[]>('GET', '/profiles'),

  startImport: (req: ImportRequest) => request<{ jobId: string }>('POST', '/import', req),

  importJob: (jobId: string) => request<ImportJob>('GET', `/import/${encodeURIComponent(jobId)}`),

  games: (q: GamesQuery = {}) =>
    request<GamesResponse>(
      'GET',
      `/games${qs({
        profile: q.profile,
        timeClass: q.timeClass,
        analyzed: q.analyzed,
        page: q.page,
        pageSize: q.pageSize,
      })}`,
    ),

  /** `profile` views the game as that profile (board orientation) when it is linked to it. */
  game: (id: string, profile?: string) =>
    request<GameDetail>('GET', `/games/${encodeURIComponent(id)}${qs({ profile })}`),

  analyzeGame: (id: string) =>
    request<{ jobId: string }>('POST', `/games/${encodeURIComponent(id)}/analyze`),

  analyzeBatch: (gameIds: string[]) =>
    request<{ jobIds: string[] }>('POST', '/analyze/batch', { gameIds }),

  jobs: (status?: string) => request<AnalysisJob[]>('GET', `/jobs${qs({ status })}`),

  cancelJob: (id: string) => request<unknown>('DELETE', `/jobs/${encodeURIComponent(id)}`),

  settings: () => request<SettingsResponse>('GET', '/settings'),

  updateSettings: (update: SettingsUpdate) => request<SettingsResponse>('PUT', '/settings', update),

  openings: (q: string) => request<OpeningLine[]>('GET', `/openings${qs({ q })}`),

  openingsByEco: (eco: string) =>
    request<OpeningLine[]>('GET', `/openings/${encodeURIComponent(eco)}`),

  health: () => request<HealthResponse>('GET', '/health'),
};

export type Api = typeof api;

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
