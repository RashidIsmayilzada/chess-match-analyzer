import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { notFound, validate } from '../http.js';
import { DEFAULT_LATEST_COUNT } from '../import/chesscom.js';

export const importBodySchema = z.object({
  username: z.string().trim().min(1, 'username is required').max(64),
  mode: z.enum(['all', 'latest']),
  count: z.number().int().positive().max(10_000).optional(),
  autoAnalyzeLatest: z.number().int().nonnegative().max(1000).optional(),
});

export type ImportBody = z.infer<typeof importBodySchema>;

export function registerImportRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/import', async (request, reply) => {
    const body = validate(importBodySchema, request.body, 'import request');
    const job = ctx.queue.enqueueImport({
      username: body.username.toLowerCase(),
      mode: body.mode,
      ...(body.mode === 'latest' ? { count: body.count ?? DEFAULT_LATEST_COUNT } : {}),
      ...(body.autoAnalyzeLatest !== undefined ? { autoAnalyzeLatest: body.autoAnalyzeLatest } : {}),
    });
    return reply.code(202).send({ jobId: job.id });
  });

  app.get<{ Params: { jobId: string } }>('/api/import/:jobId', async (request) => {
    const job = ctx.queue.getImportJob(request.params.jobId);
    if (!job) throw notFound(`Import job ${request.params.jobId} not found`);
    return job;
  });
}
