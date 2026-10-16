/**
 * drizzle-kit config (optional tooling: `npx drizzle-kit generate` / `studio`).
 * The server itself applies its schema at boot via src/db/migrate.ts.
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DB_PATH ?? '../../data/chess-analyzer.db' },
});
