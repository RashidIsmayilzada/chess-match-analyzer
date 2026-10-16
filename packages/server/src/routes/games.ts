import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../games.js';
import { notFound, validate } from '../http.js';

const booleanQuery = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const gamesQuerySchema = z.object({
  profile: z.string().trim().min(1).optional(),
  timeClass: z.enum(['bullet', 'blitz', 'rapid']).optional(),
  analyzed: booleanQuery.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export const gameQuerySchema = z.object({
  /** Profile to view the game as (sets GameRecord.profileUsername when the game is linked to it). */
  profile: z.string().trim().min(1).optional(),
});

export const batchBodySchema = z.object({
  gameIds: z.array(z.string().min(1)).min(1).max(5000),
});

export function registerGameRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/games', async (request) => {
    const query = validate(gamesQuerySchema, request.query ?? {}, 'query');
    return ctx.games.list(query, ctx.queue.currentSettingsKey());
  });

  app.get<{ Params: { id: string }; Querystring: { profile?: string } }>('/api/games/:id', async (request) => {
    const { profile } = validate(gameQuerySchema, request.query ?? {}, 'query');
    const found = ctx.games.get(request.params.id, ctx.queue.currentSettingsKey(), profile);
    if (!found) throw notFound(`Game ${request.params.id} not found`);
    return found;
  });

  app.post<{ Params: { id: string } }>('/api/games/:id/analyze', async (request, reply) => {
    const id = request.params.id;
    if (!ctx.games.getRow(id)) throw notFound(`Game ${id} not found`);
    const job = ctx.queue.enqueueAnalysis(id);
    return reply.code(202).send({ jobId: job.id });
  });

  app.post('/api/analyze/batch', async (request, reply) => {
    const body = validate(batchBodySchema, request.body, 'batch request');
    const unknown = body.gameIds.filter((id) => !ctx.games.getRow(id));
    if (unknown.length > 0) throw notFound(`Unknown game id(s): ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ', ...' : ''}`);
    const jobIds = body.gameIds.map((id) => ctx.queue.enqueueAnalysis(id).id);
    return reply.code(202).send({ jobIds });
  });
}
