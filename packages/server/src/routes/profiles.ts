import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export function registerProfileRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/profiles', async () => ctx.games.listProfiles());
}
