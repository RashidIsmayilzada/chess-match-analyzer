import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async () => {
    const settings = ctx.settings.getAnalysis();
    try {
      const engine = await ctx.engine.acquire(settings);
      return { ok: true, engine: engine.name, queueIdle: ctx.queue.isIdle, sseClients: ctx.events.clientCount };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, engine: `unavailable (${settings.enginePath}): ${message}`, queueIdle: ctx.queue.isIdle, sseClients: ctx.events.clientCount };
    }
  });
}
