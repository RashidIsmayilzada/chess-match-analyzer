/**
 * Engine module entry point. See docs/ARCHITECTURE.md (module "engine").
 * `UciEngine` lives in ./uci.ts; the pure protocol helpers in ./protocol.ts.
 */
export {
  UciEngine,
  EngineProcessError,
  DEFAULT_ENGINE_THREADS,
  DEFAULT_ENGINE_HASH_MB,
  type UciEngineOptions,
  type SearchSettings,
} from './uci.js';
export {
  parseInfoLine,
  parseBestmoveLine,
  parseIdNameLine,
  sideToMove,
  toWhitePov,
  type UciInfo,
} from './protocol.js';
