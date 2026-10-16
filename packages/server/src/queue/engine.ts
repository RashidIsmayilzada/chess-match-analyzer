/**
 * Owns the single shared Stockfish process. The engine is started lazily with the current
 * analysis settings and restarted whenever enginePath, threads or hashMb change.
 *
 * A job that uses the engine takes a lease (`lease()`); while a lease is held, `acquire()` with
 * different settings returns the running engine instead of restarting it out from under the job
 * (the restart happens on the next lease-free `acquire`, i.e. the next job). GET /api/health calls
 * `acquire` to report the engine name and must never kill a running analysis.
 *
 * acquire / lease / shutdown are serialised through one promise chain, so two callers can never
 * interleave a start, a restart and a lease.
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

export interface EngineLease {
  engine: UciEngine;
  /** Give the engine back; idempotent. */
  release(): void;
}

export function engineConfigKey(settings: Pick<AnalysisSettings, 'enginePath' | 'threads' | 'hashMb'>, repoRoot: string): string {
  return `${resolveEnginePath(settings.enginePath, repoRoot)}|threads=${settings.threads}|hash=${settings.hashMb}`;
}

export class EngineManager {
  private engine: UciEngine | undefined;
  private engineKey: string | undefined;
  private engineName: string | undefined;
  /** Jobs currently holding the engine; while > 0 the engine is never restarted by `acquire`. */
  private leases = 0;
  /** Serialises acquire / lease / shutdown. */
  private chain: Promise<unknown> = Promise.resolve();
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

  /** True while a job holds the engine (see `lease`). */
  get isLeased(): boolean {
    return this.leases > 0;
  }

  /** True when the running engine does not match `settings` and will be restarted by the next job. */
  restartPendingFor(settings: AnalysisSettings): boolean {
    return this.engine !== undefined && this.engineKey !== engineConfigKey(settings, this.opts.repoRoot);
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

  /**
   * Get an engine matching `settings`, starting or restarting the process when needed. While a
   * lease is held the running engine is returned even when its settings differ; the restart is
   * deferred to the next lease-free call.
   */
  acquire(settings: AnalysisSettings): Promise<UciEngine> {
    return this.serialize(() => this.acquireNow(settings));
  }

  /** Acquire the engine for a job. Until `release()` is called no `acquire` restarts it. */
  lease(settings: AnalysisSettings): Promise<EngineLease> {
    return this.serialize(async () => {
      const engine = await this.acquireNow(settings);
      this.leases += 1;
      let released = false;
      return {
        engine,
        release: () => {
          if (released) return;
          released = true;
          this.leases -= 1;
        },
      };
    });
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
  shutdown(): Promise<void> {
    return this.serialize(() => this.shutdownNow());
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async acquireNow(settings: AnalysisSettings): Promise<UciEngine> {
    const key = engineConfigKey(settings, this.opts.repoRoot);
    if (this.engine && this.engineKey === key) return this.engine;
    if (this.engine && this.leases > 0) {
      this.opts.log?.info('engine settings changed while a job is running; restart deferred to the next job');
      return this.engine;
    }
    return this.restart(settings, key);
  }

  private async restart(settings: AnalysisSettings, key: string): Promise<UciEngine> {
    await this.shutdownNow();
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

  private async shutdownNow(): Promise<void> {
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
