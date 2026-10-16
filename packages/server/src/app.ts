/**
 * buildApp(): assembles database, settings, engine manager, queue, SSE hub and routes into a
 * Fastify instance. Heavy collaborators (engine, analysis, opening book, fetch) are injectable
 * so tests can run without Stockfish or the network.
 */
import fs from 'node:fs';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { loadDefaultBook, type OpeningBook } from '@chess-analyzer/core';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { loadConfig, type ServerConfig } from './config.js';
import type { AppContext } from './context.js';
import { openDatabase } from './db/index.js';
import { EventHub, HEARTBEAT_INTERVAL_MS } from './events.js';
import { GameRepository } from './games.js';
import { registerErrorHandler } from './http.js';
import { ChesscomClient } from './import/chesscom.js';
import { EngineManager, type EngineFactory } from './queue/engine.js';
import { JobQueue, type AnalyzeGameFn, type ImportGamesFn, type SettingsKeyFn } from './queue/index.js';
import { registerRoutes } from './routes/index.js';
import { SettingsService } from './settings.js';

export interface AppDeps {
  /** Spawns the UCI engine (default: core UciEngine). */
  createEngine?: EngineFactory;
  /** Loads the opening book (default: core loadDefaultBook on config.openingsDir). */
  loadBook?: (openingsDir: string) => Promise<OpeningBook>;
  analyzeGame?: AnalyzeGameFn;
  settingsKey?: SettingsKeyFn;
  importGames?: ImportGamesFn;
  openingNameFromEcoUrl?: (url: string) => string;
  /** fetch used by the chess.com client. */
  fetch?: typeof fetch;
  now?: () => Date;
  /** SSE heartbeat interval in ms (default 15 s). */
  heartbeatMs?: number;
}

export interface BuildAppOptions {
  config?: Partial<ServerConfig>;
  env?: NodeJS.ProcessEnv;
  logger?: FastifyServerOptions['logger'];
  deps?: AppDeps;
  /** Start the queue worker immediately (default true). */
  startQueue?: boolean;
}

export type App = FastifyInstance & { ctx: AppContext };

export async function buildApp(opts: BuildAppOptions = {}): Promise<App> {
  const config = loadConfig(opts.env ?? process.env, opts.config);
  const deps = opts.deps ?? {};
  const now = deps.now ?? (() => new Date());

  const app = Fastify({ logger: opts.logger ?? false, trustProxy: false }) as unknown as App;
  registerErrorHandler(app);
  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] });

  const database = openDatabase(config.dbPath);
  const settings = new SettingsService(database.db, { enginePath: config.enginePath });
  const events = new EventHub(deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
  const log = {
    info: (msg: string) => app.log.info(msg),
    warn: (msg: string) => app.log.warn(msg),
    error: (msg: string) => app.log.error(msg),
  };
  const engine = new EngineManager({ repoRoot: config.repoRoot, settings, createEngine: deps.createEngine, log });
  const book = await (deps.loadBook ?? loadDefaultBook)(config.openingsDir);
  const games = new GameRepository(database.db);
  const queue = new JobQueue({
    db: database.db,
    settings,
    events,
    engine,
    book,
    analyzeGame: deps.analyzeGame,
    settingsKey: deps.settingsKey,
    importGames: deps.importGames,
    chesscomClient: new ChesscomClient({ fetch: deps.fetch }),
    openingNameFromEcoUrl: deps.openingNameFromEcoUrl,
    now,
    log,
  });

  const ctx: AppContext = { config, database, settings, events, engine, queue, games, book };
  app.ctx = ctx;
  registerRoutes(app, ctx);

  const webIndex = `${config.webDist}/index.html`;
  if (fs.existsSync(webIndex)) {
    await app.register(fastifyStatic, { root: config.webDist, prefix: '/', wildcard: false, index: ['index.html'] });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: `Route ${request.method} ${request.url} not found` });
    });
  } else {
    app.setNotFoundHandler((request, reply) => reply.code(404).send({ error: `Route ${request.method} ${request.url} not found` }));
  }

  // Fastify runs preClose before it closes the HTTP server, which only waits for active sockets
  // to finish: the open SSE responses must be ended here, or `close()` hangs until every
  // EventSource client goes away (onClose hooks run only after the server has closed).
  app.addHook('preClose', async () => {
    events.close();
  });
  app.addHook('onClose', async () => {
    await queue.stop();
    database.close();
  });

  if (opts.startQueue !== false) {
    app.addHook('onReady', async () => {
      queue.start();
    });
  }

  return app;
}
