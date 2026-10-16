/**
 * UCI engine wrapper. See docs/ARCHITECTURE.md (module "engine").
 *
 * - Spawns the binary with child_process, line-buffers stdout.
 * - `start()` runs the `uci` handshake, applies Threads / Hash / MultiPV / UCI_ShowWDL and
 *   waits for `readyok`.
 * - `analyse()` sends `position fen ...` + `go depth N` (or `go movetime N`), collects the
 *   `info ... multipv K ... pv ...` lines keeping, per multipv, the last line at the deepest
 *   depth seen (bound lines are ignored), and resolves on `bestmove`.
 * - Scores are normalised to WHITE POV (UCI reports from the side to move).
 * - Concurrent `analyse()` / `setOptions()` calls are serialised through a promise queue:
 *   exactly one command sequence talks to the engine at any time.
 * - `stop()` interrupts the running search; the pending `analyse()` resolves with the best
 *   result collected so far.
 * - A position with no legal moves (checkmate / stalemate) makes the engine answer
 *   `bestmove (none)`; `analyse()` then resolves with an empty `lines` array.
 * - Unexpected process exit or spawn errors reject every pending call and every later call.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import type { AnalysisSettings, EngineLine, PositionAnalysis } from '../types.js';
import { parseBestmoveLine, parseIdNameLine, parseInfoLine, sideToMove, toWhitePov } from './protocol.js';

export interface UciEngineOptions {
  enginePath: string;
  threads?: number;
  hashMb?: number;
  /** Called with raw engine stdout lines, for debugging. */
  onLine?: (line: string) => void;
}

export type SearchSettings = Pick<AnalysisSettings, 'depth' | 'multiPv' | 'movetimeMs'>;

/** Error raised when the engine process is gone (never started, quit, crashed). */
export class EngineProcessError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null = null,
    public readonly signal: NodeJS.Signals | null = null,
  ) {
    super(message);
    this.name = 'EngineProcessError';
  }
}

/** Engine defaults (Stockfish's own) used when the caller does not specify them. */
export const DEFAULT_ENGINE_THREADS = 1;
export const DEFAULT_ENGINE_HASH_MB = 16;

/** How long `start()` waits for `uciok` / `readyok` before giving up. */
const HANDSHAKE_TIMEOUT_MS = 15_000;
/** How long `quit()` waits for a clean exit before SIGKILL. */
const QUIT_TIMEOUT_MS = 3_000;

type Process = ChildProcessByStdio<Writable, Readable, Readable>;

interface LineWaiter {
  /** Return true to consume the line and settle the waiter. */
  test: (line: string) => boolean;
  resolve: () => void;
  reject: (err: Error) => void;
}

/** State of the search that is currently talking to the engine. */
interface ActiveSearch {
  fen: string;
  mover: 'w' | 'b';
  /** Best line seen so far per multipv rank. */
  lines: Map<number, EngineLine>;
}

export class UciEngine {
  private readonly opts: UciEngineOptions;
  private proc: Process | undefined;
  private started = false;
  private exited = false;
  private exitError: EngineProcessError | undefined;
  private engineName = '';
  private stdoutBuffer = '';
  private stderrTail = '';
  private waiters: LineWaiter[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private active: ActiveSearch | undefined;
  private currentMultiPv: number | undefined;
  private currentThreads: number;
  private currentHashMb: number;

  constructor(opts: UciEngineOptions) {
    if (!opts.enginePath) throw new Error('UciEngine: enginePath is required');
    this.opts = opts;
    this.currentThreads = opts.threads ?? DEFAULT_ENGINE_THREADS;
    this.currentHashMb = opts.hashMb ?? DEFAULT_ENGINE_HASH_MB;
  }

  /** Engine identification, e.g. "Stockfish 19". Empty until `start()` has resolved. */
  get name(): string {
    return this.engineName;
  }

  /** True while the process is alive and the handshake has completed. */
  get isRunning(): boolean {
    return this.started && !this.exited;
  }

  /** Spawn the process, run `uci`, apply options, wait for `readyok`. Resolves with the engine name. */
  async start(): Promise<string> {
    if (this.proc) {
      if (this.exited) throw this.exitError ?? new EngineProcessError('engine process has exited');
      if (this.started) return this.engineName;
      throw new Error('UciEngine.start() already in progress');
    }
    this.spawnProcess();

    const uciok = this.waitForLine((line) => {
      const name = parseIdNameLine(line);
      if (name !== undefined) this.engineName = name;
      return line === 'uciok';
    }, HANDSHAKE_TIMEOUT_MS);
    this.send('uci');
    await uciok;

    this.send(`setoption name Threads value ${this.currentThreads}`);
    this.send(`setoption name Hash value ${this.currentHashMb}`);
    this.send('setoption name UCI_ShowWDL value false');
    await this.sync(HANDSHAKE_TIMEOUT_MS);

    this.started = true;
    return this.engineName;
  }

  /** Analyse a position. Calls are serialised: a second call waits for the first to finish. */
  analyse(fen: string, settings: SearchSettings): Promise<PositionAnalysis> {
    return this.enqueue(() => this.runSearch(fen, settings));
  }

  /** Interrupt the current search (the pending analyse() resolves with the best result so far). */
  stop(): void {
    if (!this.active || !this.proc || this.exited) return;
    this.send('stop');
  }

  /** Change Threads / Hash at runtime (between searches). */
  setOptions(opts: { threads?: number; hashMb?: number }): Promise<void> {
    return this.enqueue(async () => {
      this.assertRunning();
      let changed = false;
      if (opts.threads !== undefined && opts.threads !== this.currentThreads) {
        this.currentThreads = opts.threads;
        this.send(`setoption name Threads value ${opts.threads}`);
        changed = true;
      }
      if (opts.hashMb !== undefined && opts.hashMb !== this.currentHashMb) {
        this.currentHashMb = opts.hashMb;
        this.send(`setoption name Hash value ${opts.hashMb}`);
        changed = true;
      }
      if (changed) await this.sync(HANDSHAKE_TIMEOUT_MS);
    });
  }

  /**
   * Ask the engine to quit and wait for the process to exit (SIGKILL after a grace period).
   * A search that is still running is stopped by the engine, which answers `bestmove` before
   * exiting, so its pending analyse() resolves with the best result so far.
   */
  async quit(): Promise<void> {
    const proc = this.proc;
    if (!proc || this.exited) {
      this.exited = true;
      return;
    }
    const exitedPromise = new Promise<void>((resolve) => {
      proc.once('close', () => resolve());
    });
    try {
      this.send('quit');
    } catch {
      // stdin already closed; fall through to waiting / killing.
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        if (!this.exited) proc.kill('SIGKILL');
        resolve();
      }, QUIT_TIMEOUT_MS);
      // Do not keep the event loop alive just for this grace period.
      timer.unref?.();
    });
    await Promise.race([exitedPromise, timeout]);
    if (timer) clearTimeout(timer);
    await exitedPromise;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private spawnProcess(): void {
    let proc: Process;
    try {
      proc = spawn(this.opts.enginePath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      const e = new EngineProcessError(`failed to spawn engine "${this.opts.enginePath}": ${String(err)}`);
      this.exited = true;
      this.exitError = e;
      throw e;
    }
    this.proc = proc;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    // A write after the engine died must not crash the host process.
    proc.stdin.on('error', (err: Error) => this.onProcessGone(`engine stdin error: ${err.message}`));
    proc.on('error', (err: Error) =>
      this.onProcessGone(`engine process error (${this.opts.enginePath}): ${err.message}`),
    );
    // 'close' (not 'exit') fires only after stdout has been fully drained, so a final
    // `bestmove` written just before the engine exits is still delivered to its waiter.
    proc.on('close', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      const stderr = this.stderrTail.trim();
      this.onProcessGone(
        `engine process exited (${detail})${stderr ? `: ${stderr}` : ''}`,
        code,
        signal,
      );
    });
  }

  private onProcessGone(message: string, code: number | null = null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitError = new EngineProcessError(message, code, signal);
    const err = this.exitError;
    const waiters = this.waiters;
    this.waiters = [];
    this.active = undefined;
    for (const w of waiters) w.reject(err);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nl: number;
    while ((nl = this.stdoutBuffer.indexOf('\n')) >= 0) {
      let line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      line = line.trim();
      if (line.length === 0) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    this.opts.onLine?.(line);
    if (this.active && line.startsWith('info')) this.collectInfo(line);
    // Waiters are checked in order; the first that consumes the line wins.
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i]!;
      let matched = false;
      try {
        matched = w.test(line);
      } catch (err) {
        this.waiters.splice(i, 1);
        w.reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (matched) {
        this.waiters.splice(i, 1);
        w.resolve();
        return;
      }
    }
  }

  private collectInfo(line: string): void {
    const search = this.active!;
    const info = parseInfoLine(line);
    if (!info || info.bound || !info.score || info.depth === undefined) return;
    // Lines without a pv (e.g. `info depth 0 score mate 0`) carry no move; skip them unless
    // they are the primary line, which may legitimately be empty for a single-legal-move
    // position (filled in from `bestmove` later).
    const multipv = info.multipv ?? 1;
    if (info.pv.length === 0 && multipv !== 1) return;
    const existing = search.lines.get(multipv);
    if (existing && existing.depth > info.depth) return;
    search.lines.set(multipv, {
      multipv,
      depth: info.depth,
      score: toWhitePov(info.score, search.mover),
      pv: info.pv.slice(),
    });
  }

  private async runSearch(fen: string, settings: SearchSettings): Promise<PositionAnalysis> {
    this.assertRunning();
    const multiPv = Math.max(1, Math.floor(settings.multiPv));
    if (multiPv !== this.currentMultiPv) {
      this.send(`setoption name MultiPV value ${multiPv}`);
      this.currentMultiPv = multiPv;
      await this.sync(HANDSHAKE_TIMEOUT_MS);
    }

    const search: ActiveSearch = { fen, mover: sideToMove(fen), lines: new Map() };
    this.active = search;
    let bestmove: string | null = null;
    const done = this.waitForLine((line) => {
      const parsed = parseBestmoveLine(line);
      if (parsed === undefined) return false;
      bestmove = parsed;
      return true;
    });
    // If sending the commands throws, `done` rejects on its own; keep that from surfacing
    // as an unhandled rejection (the thrown error is what the caller sees).
    done.catch(() => undefined);

    try {
      this.send(`position fen ${fen.trim()}`);
      if (settings.movetimeMs !== undefined && settings.movetimeMs > 0) {
        this.send(`go movetime ${Math.floor(settings.movetimeMs)}`);
      } else {
        this.send(`go depth ${Math.max(1, Math.floor(settings.depth))}`);
      }
      await done;
    } finally {
      if (this.active === search) this.active = undefined;
    }

    const lines = this.finaliseLines(search, bestmove);
    return {
      fen,
      depth: lines.reduce((d, l) => Math.max(d, l.depth), 0),
      multipv: multiPv,
      lines,
      engine: this.engineName,
    };
  }

  private finaliseLines(search: ActiveSearch, bestmove: string | null): EngineLine[] {
    if (bestmove === null) return []; // no legal moves: checkmate / stalemate
    const lines = [...search.lines.values()].sort((a, b) => a.multipv - b.multipv);
    const first = lines[0];
    if (first && first.multipv === 1 && first.pv.length === 0) {
      // Single-legal-move shortcut: Stockfish reports `pv` empty and names the move in bestmove.
      first.pv = [bestmove];
    }
    // Drop any remaining line without a move; it is unusable for callers.
    return lines.filter((l) => l.pv.length > 0);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private assertRunning(): void {
    if (this.exited) throw this.exitError ?? new EngineProcessError('engine process has exited');
    if (!this.proc || !this.started) throw new EngineProcessError('engine not started: call start() first');
  }

  private send(command: string): void {
    if (!this.proc || this.exited) {
      throw this.exitError ?? new EngineProcessError('engine process is not running');
    }
    this.proc.stdin.write(`${command}\n`);
  }

  /** Send `isready` and wait for `readyok`. */
  private sync(timeoutMs?: number): Promise<void> {
    const ready = this.waitForLine((line) => line === 'readyok', timeoutMs);
    this.send('isready');
    return ready;
  }

  /**
   * Resolve when a stdout line satisfies `test`. Rejects if the process goes away first or,
   * when `timeoutMs` is given, if nothing matched in time.
   */
  private waitForLine(test: (line: string) => boolean, timeoutMs?: number): Promise<void> {
    if (this.exited) {
      return Promise.reject(this.exitError ?? new EngineProcessError('engine process has exited'));
    }
    return new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const waiter: LineWaiter = {
        test,
        resolve: () => {
          if (timer) clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(new EngineProcessError(`engine did not respond within ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.waiters.push(waiter);
    });
  }
}
