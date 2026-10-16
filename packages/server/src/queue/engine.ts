/**
 * Owns the single shared Stockfish process. The engine is started lazily with the current
 * analysis settings and restarted whenever enginePath, threads or hashMb change.
 */
import { UciEngine, type AnalysisSettings, type UciEngineOptions } from '@chess-analyzer/core';
import { resolveEnginePath } from '../config.js';
import type { SettingsService } from '../settings.js';

export type EngineFactory = (opts: UciEngineOptions) => UciEngine;

export const defaultEngineFactory: EngineFactory = (opts) => new UciEngine(opts);

export interface EngineManagerOptions {
  repoRoot: string;
  settings: SettingsService;
  createEngine?: EngineFactory;
  log?: { info(msg: string): void; warn(msg: string): void };
}

export function engineConfigKey(settings: Pick<AnalysisSettings, 'enginePath' | 'threads' | 'hashMb'>, repoRoot: string): string {
  return `${resolveEnginePath(settings.enginePath, repoRoot)}|threads=${settings.threads}|hash=${settings.hashMb}`;
}

export class EngineManager {
  private engine: UciEngine | undefined;
  private engineKey: string | undefined;
  private engineName: string | undefined;
  private pending: Promise<UciEngine> | undefined;
  private readonly createEngine: EngineFactory;

  constructor(private readonly opts: EngineManagerOptions) {
    this.createEngine = opts.createEngine ?? defaultEngineFactory;
  }

  /** Name of the running engine, if any. */
  get currentName(): string | undefined {
    return this.engine ? this.engineName : undefined;
  }

  get isRunning(): boolean {
    return this.engine !== undefined;
  }

  /**
   * Engine name for the given settings: the running engine's name, or the name remembered
   * from an earlier start of the same binary. Undefined when the binary never ran.
   */
  engineNameFor(settings: Pick<AnalysisSettings, 'enginePath'>): string | undefined {
    const resolved = resolveEnginePath(settings.enginePath, this.opts.repoRoot);
    if (this.engine && this.engineKey?.startsWith(`${resolved}|`)) return this.engineName;
    return this.opts.settings.knownEngineName(resolved);
  }

  /** Get an engine matching `settings`, starting or restarting the process when needed. */
  async acquire(settings: AnalysisSettings): Promise<UciEngine> {
    const key = engineConfigKey(settings, this.opts.repoRoot);
    if (this.pending) {
      const running = await this.pending.catch(() => undefined);
      if (running && this.engineKey === key) return running;
    }
    if (this.engine && this.engineKey === key) return this.engine;

    this.pending = this.restart(settings, key);
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  private async restart(settings: AnalysisSettings, key: string): Promise<UciEngine> {
    await this.shutdown();
    const enginePath = resolveEnginePath(settings.enginePath, this.opts.repoRoot);
    const engine = this.createEngine({ enginePath, threads: settings.threads, hashMb: settings.hashMb });
    this.opts.log?.info(`starting engine ${enginePath} (threads=${settings.threads}, hash=${settings.hashMb}MB)`);
    const name = await engine.start();
    this.engine = engine;
    this.engineKey = key;
    this.engineName = name;
    this.opts.settings.rememberEngineName(enginePath, name);
    this.opts.log?.info(`engine ready: ${name}`);
    return engine;
  }

  /** Interrupt the current search, if any. */
  stopSearch(): void {
    try {
      this.engine?.stop();
    } catch (err) {
      this.opts.log?.warn(`engine stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Quit the engine process. The next `acquire` starts a fresh one. */
  async shutdown(): Promise<void> {
    const engine = this.engine;
    this.engine = undefined;
    this.engineKey = undefined;
    this.engineName = undefined;
    if (!engine) return;
    try {
      await engine.quit();
    } catch (err) {
      this.opts.log?.warn(`engine quit failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
