/**
 * SQLite-backed implementation of the core `PositionCache` interface, keyed by the REQUESTED
 * search settings (fen, depth, multipv, engine, movetime_ms) in the `position_analyses` table.
 * movetime_ms is 0 for depth-limited searches; a time-limited search reaches an arbitrary depth
 * and must never be served as a fixed-depth result (or the other way round).
 */
import type { EngineLine, PositionAnalysis, PositionCache } from '@chess-analyzer/core';
import { and, count, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { positionAnalyses } from '../db/schema.js';

export class SqlitePositionCache implements PositionCache {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(fen: string, depth: number, multiPv: number, engine: string, movetimeMs = 0): Promise<PositionAnalysis | undefined> {
    const row = this.db
      .select()
      .from(positionAnalyses)
      .where(
        and(
          eq(positionAnalyses.fen, fen),
          eq(positionAnalyses.depth, depth),
          eq(positionAnalyses.multipv, multiPv),
          eq(positionAnalyses.engine, engine),
          eq(positionAnalyses.movetimeMs, movetimeMs),
        ),
      )
      .get();
    if (!row) return undefined;
    let lines: EngineLine[];
    try {
      lines = JSON.parse(row.linesJson) as EngineLine[];
    } catch {
      return undefined;
    }
    return { fen: row.fen, depth: row.depth, multipv: row.multipv, engine: row.engine, lines };
  }

  async set(analysis: PositionAnalysis, movetimeMs = 0): Promise<void> {
    const linesJson = JSON.stringify(analysis.lines);
    this.db
      .insert(positionAnalyses)
      .values({
        fen: analysis.fen,
        depth: analysis.depth,
        multipv: analysis.multipv,
        engine: analysis.engine,
        movetimeMs,
        linesJson,
        createdAt: this.now().toISOString(),
      })
      .onConflictDoUpdate({
        target: [positionAnalyses.fen, positionAnalyses.depth, positionAnalyses.multipv, positionAnalyses.engine, positionAnalyses.movetimeMs],
        set: { linesJson },
      })
      .run();
  }

  /** Number of cached positions (for diagnostics). */
  size(): number {
    return this.db.select({ value: count() }).from(positionAnalyses).get()?.value ?? 0;
  }
}
