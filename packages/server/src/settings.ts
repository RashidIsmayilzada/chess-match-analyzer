/**
 * Settings service: documented defaults merged with overrides stored in the `settings` table.
 *
 *   key 'analysis'    -> partial AnalysisSettings overrides
 *   key 'thresholds'  -> deep-partial Thresholds overrides
 *   key 'engineNames' -> { [enginePath]: engine name } learned when an engine was started
 */
import { DEFAULT_THRESHOLDS, type AnalysisSettings, type Thresholds } from '@chess-analyzer/core';
import { eq } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { settings as settingsTable } from './db/schema.js';
import { DEFAULT_ENGINE_PATH } from './config.js';

export interface EffectiveSettings {
  analysis: AnalysisSettings;
  thresholds: Thresholds;
}

export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export interface SettingsPatch {
  /** `movetimeMs: null` clears a previously set movetime. */
  analysis?: Partial<Omit<AnalysisSettings, 'movetimeMs'>> & { movetimeMs?: number | null };
  thresholds?: DeepPartial<Thresholds>;
}

export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = {
  depth: 18,
  multiPv: 3,
  threads: 8,
  hashMb: 512,
  enginePath: DEFAULT_ENGINE_PATH,
};

export const SETTINGS_KEYS = {
  analysis: 'analysis',
  thresholds: 'thresholds',
  engineNames: 'engineNames',
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively merge `patch` into `base`. Arrays and scalars are replaced; `undefined` is skipped; `null` deletes. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      delete out[key];
      continue;
    }
    out[key] = isPlainObject(out[key]) && isPlainObject(value) ? deepMerge(out[key], value) : value;
  }
  return out as T;
}

export class SettingsService {
  constructor(
    private readonly db: Db,
    private readonly defaults: { enginePath?: string } = {},
  ) {}

  /** Raw stored JSON value for a key, if any. */
  getRaw<T>(key: string): T | undefined {
    const row = this.db.select().from(settingsTable).where(eq(settingsTable.key, key)).get();
    if (!row) return undefined;
    try {
      return JSON.parse(row.valueJson) as T;
    } catch {
      return undefined;
    }
  }

  setRaw(key: string, value: unknown): void {
    const valueJson = JSON.stringify(value);
    this.db
      .insert(settingsTable)
      .values({ key, valueJson })
      .onConflictDoUpdate({ target: settingsTable.key, set: { valueJson } })
      .run();
  }

  private analysisDefaults(): AnalysisSettings {
    return { ...DEFAULT_ANALYSIS_SETTINGS, enginePath: this.defaults.enginePath ?? DEFAULT_ENGINE_PATH };
  }

  getAnalysis(): AnalysisSettings {
    const stored = this.getRaw<Partial<AnalysisSettings>>(SETTINGS_KEYS.analysis) ?? {};
    return deepMerge(this.analysisDefaults(), stored);
  }

  getThresholds(): Thresholds {
    const stored = this.getRaw<DeepPartial<Thresholds>>(SETTINGS_KEYS.thresholds) ?? {};
    return deepMerge(structuredClone(DEFAULT_THRESHOLDS), stored);
  }

  getAll(): EffectiveSettings {
    return { analysis: this.getAnalysis(), thresholds: this.getThresholds() };
  }

  /** Merge a patch into the stored overrides and return the new effective settings. */
  update(patch: SettingsPatch): EffectiveSettings {
    if (patch.analysis) {
      const stored = this.getRaw<Partial<AnalysisSettings>>(SETTINGS_KEYS.analysis) ?? {};
      this.setRaw(SETTINGS_KEYS.analysis, deepMerge(stored, patch.analysis));
    }
    if (patch.thresholds) {
      const stored = this.getRaw<DeepPartial<Thresholds>>(SETTINGS_KEYS.thresholds) ?? {};
      this.setRaw(SETTINGS_KEYS.thresholds, deepMerge(stored, patch.thresholds));
    }
    return this.getAll();
  }

  /** Drop every stored override. */
  reset(): EffectiveSettings {
    this.db.delete(settingsTable).where(eq(settingsTable.key, SETTINGS_KEYS.analysis)).run();
    this.db.delete(settingsTable).where(eq(settingsTable.key, SETTINGS_KEYS.thresholds)).run();
    return this.getAll();
  }

  /** Engine name last reported by the engine at `enginePath`, if it was ever started. */
  knownEngineName(enginePath: string): string | undefined {
    const names = this.getRaw<Record<string, string>>(SETTINGS_KEYS.engineNames) ?? {};
    return names[enginePath];
  }

  rememberEngineName(enginePath: string, name: string): void {
    const names = this.getRaw<Record<string, string>>(SETTINGS_KEYS.engineNames) ?? {};
    if (names[enginePath] === name) return;
    this.setRaw(SETTINGS_KEYS.engineNames, { ...names, [enginePath]: name });
  }
}
