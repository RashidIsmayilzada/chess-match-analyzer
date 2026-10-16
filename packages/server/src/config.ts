/**
 * Server configuration, resolved from environment variables with repo-relative defaults.
 *
 *   PORT        HTTP port (default 3001)
 *   HOST        bind address (default 127.0.0.1)
 *   DB_PATH     SQLite file (default <repo>/data/chess-analyzer.db, ':memory:' for tests)
 *   ENGINE_PATH default UCI engine path (default engines/stockfish, relative to the repo root)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  port: number;
  host: string;
  /** SQLite file path or ':memory:'. */
  dbPath: string;
  /** Default engine path; absolute or relative to `repoRoot`. */
  enginePath: string;
  /** Absolute path of the repository root. */
  repoRoot: string;
  /** Absolute path of the openings TSV directory. */
  openingsDir: string;
  /** Absolute path of the built web app (served statically when it exists). */
  webDist: string;
}

/** Both `src/config.ts` and `dist/config.js` sit one directory below packages/server. */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));

export const DEFAULT_PORT = 3001;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_ENGINE_PATH = 'engines/stockfish';

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ServerConfig> = {}): ServerConfig {
  const repoRoot = overrides.repoRoot ?? REPO_ROOT;
  const portRaw = env.PORT ? Number.parseInt(env.PORT, 10) : DEFAULT_PORT;
  const port = Number.isFinite(portRaw) && portRaw >= 0 ? portRaw : DEFAULT_PORT;
  return {
    port,
    host: env.HOST && env.HOST.length > 0 ? env.HOST : DEFAULT_HOST,
    dbPath: env.DB_PATH && env.DB_PATH.length > 0 ? env.DB_PATH : path.join(repoRoot, 'data', 'chess-analyzer.db'),
    enginePath: env.ENGINE_PATH && env.ENGINE_PATH.length > 0 ? env.ENGINE_PATH : DEFAULT_ENGINE_PATH,
    repoRoot,
    openingsDir: path.join(repoRoot, 'data', 'openings'),
    webDist: path.join(repoRoot, 'packages', 'web', 'dist'),
    ...overrides,
  };
}

/** Resolve an engine path that may be relative to the repository root. */
export function resolveEnginePath(enginePath: string, repoRoot: string): string {
  return path.isAbsolute(enginePath) ? enginePath : path.resolve(repoRoot, enginePath);
}
