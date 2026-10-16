import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { registerEventsRoute } from '../events.js';
import { registerGameRoutes } from './games.js';
import { registerHealthRoutes } from './health.js';
import { registerImportRoutes } from './import.js';
import { registerJobRoutes } from './jobs.js';
import { registerOpeningRoutes } from './openings.js';
import { registerProfileRoutes } from './profiles.js';
import { registerSettingsRoutes } from './settings.js';

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  registerProfileRoutes(app, ctx);
  registerImportRoutes(app, ctx);
  registerGameRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerEventsRoute(app, ctx.events);
  registerSettingsRoutes(app, ctx);
  registerOpeningRoutes(app, ctx);
  registerHealthRoutes(app, ctx);
}
