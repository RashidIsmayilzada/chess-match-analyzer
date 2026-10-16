import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { notFound, validate } from '../http.js';

export const OPENINGS_LIMIT = 200;

const openingsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
});

export function registerOpeningRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/openings', async (request) => {
    const { q } = validate(openingsQuerySchema, request.query ?? {}, 'query');
    const lines = q ? ctx.book.search(q, OPENINGS_LIMIT) : ctx.book.list().slice(0, OPENINGS_LIMIT);
    return lines.slice(0, OPENINGS_LIMIT).map((line) => ({ eco: line.eco, name: line.name, pgn: line.pgn }));
  });

  app.get<{ Params: { eco: string } }>('/api/openings/:eco', async (request) => {
    const eco = request.params.eco.toUpperCase();
    const lines = ctx.book.byEco(eco);
    if (lines.length === 0) throw notFound(`No openings for ECO ${eco}`);
    return lines.map((line) => ({ eco: line.eco, name: line.name, pgn: line.pgn, moves: line.moves }));
  });
}
