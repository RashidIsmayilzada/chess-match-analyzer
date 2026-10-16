/**
 * SQLite-backed implementation of the core `PositionCache` interface, keyed by
 * (fen, depth, multipv, engine) in the `position_analyses` table.
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

  async get(fen: string, depth: number, multiPv: number, engine: string): Promise<PositionAnalysis | undefined> {
    const row = this.db
      .select()
      .from(positionAnalyses)
      .where(
        and(
          eq(positionAnalyses.fen, fen),
          eq(positionAnalyses.depth, depth),
          eq(positionAnalyses.multipv, multiPv),
          eq(positionAnalyses.engine, engine),
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

  async set(analysis: PositionAnalysis): Promise<void> {
    const linesJson = JSON.stringify(analysis.lines);
    this.db
      .insert(positionAnalyses)
      .values({
        fen: analysis.fen,
        depth: analysis.depth,
        multipv: analysis.multipv,
        engine: analysis.engine,
        linesJson,
        createdAt: this.now().toISOString(),
      })
      .onConflictDoUpdate({
        target: [positionAnalyses.fen, positionAnalyses.depth, positionAnalyses.multipv, positionAnalyses.engine],
        set: { linesJson },
      })
      .run();
  }

  /** Number of cached positions (for diagnostics). */
  size(): number {
    return this.db.select({ value: count() }).from(positionAnalyses).get()?.value ?? 0;
  }
}
