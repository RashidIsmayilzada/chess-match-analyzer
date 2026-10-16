import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { notFound, validate } from '../http.js';
import { JOB_STATUSES } from '../queue/jobs.js';

export const jobsQuerySchema = z.object({
  status: z.enum(JOB_STATUSES as [string, ...string[]]).optional(),
  kind: z.enum(['analysis', 'import']).default('analysis'),
});

export function registerJobRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/jobs', async (request) => {
    const query = validate(jobsQuerySchema, request.query ?? {}, 'query');
    const status = query.status as (typeof JOB_STATUSES)[number] | undefined;
    return query.kind === 'import' ? ctx.queue.listImportJobs(status) : ctx.queue.listAnalysisJobs(status);
  });

  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (request) => {
    const row = ctx.queue.getJob(request.params.id);
    if (!row) throw notFound(`Job ${request.params.id} not found`);
    const cancelled = ctx.queue.cancel(request.params.id);
    return { id: row.id, cancelled, status: ctx.queue.getJob(row.id)?.status ?? row.status };
  });
}
