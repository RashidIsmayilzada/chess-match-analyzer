/**
 * Everything the routes need, assembled by buildApp().
 */
import type { OpeningBook } from '@chess-analyzer/core';
import type { ServerConfig } from './config.js';
import type { OpenedDatabase } from './db/index.js';
import type { EventHub } from './events.js';
import type { GameRepository } from './games.js';
import type { EngineManager } from './queue/engine.js';
import type { JobQueue } from './queue/index.js';
import type { SettingsService } from './settings.js';

export interface AppContext {
  config: ServerConfig;
  database: OpenedDatabase;
  settings: SettingsService;
  events: EventHub;
  engine: EngineManager;
  queue: JobQueue;
  games: GameRepository;
  book: OpeningBook;
}
