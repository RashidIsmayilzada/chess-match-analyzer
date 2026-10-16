/**
 * Server entry point: `node dist/index.js` or `tsx src/index.ts`.
 */
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const app = await buildApp({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const { host, port, dbPath, webDist } = app.ctx.config;

  const shutdown = (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    app
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        app.log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ host, port });
  app.log.info(`database: ${dbPath}`);
  app.log.info(`openings: ${app.ctx.book.size} lines`);
  app.log.info(`web dist: ${webDist}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
