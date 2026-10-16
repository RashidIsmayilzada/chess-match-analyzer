import { useEffect, useState, type FormEvent, type JSX } from 'react';
import type { AnalysisSettings, Thresholds } from '@chess-analyzer/core';
import { DEFAULT_THRESHOLDS } from '@chess-analyzer/core/thresholds';
import { api, errorMessage } from '../api/client';

const DEPTH_PRESETS = [18, 20, 24] as const;

interface FormState {
  depth: string;
  multiPv: string;
  threads: string;
  hashMb: string;
  movetimeMs: string;
  enginePath: string;
}

function toForm(s: AnalysisSettings): FormState {
  return {
    depth: String(s.depth),
    multiPv: String(s.multiPv),
    threads: String(s.threads),
    hashMb: String(s.hashMb),
    movetimeMs: s.movetimeMs === undefined ? '' : String(s.movetimeMs),
    enginePath: s.enginePath,
  };
}

function intField(value: string, name: string, min: number, max: number): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isInteger(n)) throw new Error(`${name} must be a whole number`);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
}

function fromForm(f: FormState): AnalysisSettings {
  const out: AnalysisSettings = {
    depth: intField(f.depth, 'Depth', 1, 99),
    multiPv: intField(f.multiPv, 'MultiPV', 1, 10),
    threads: intField(f.threads, 'Threads', 1, 256),
    hashMb: intField(f.hashMb, 'Hash', 1, 65536),
    enginePath: f.enginePath.trim(),
  };
  if (out.enginePath === '') throw new Error('Engine path is required');
  if (f.movetimeMs.trim() !== '') out.movetimeMs = intField(f.movetimeMs, 'Movetime', 1, 600000);
  return out;
}

/** Deep structural check: `value` must have the same keys and primitive types as `template`. */
function validateShape(value: unknown, template: unknown, path: string): string[] {
  const errors: string[] = [];
  if (template !== null && typeof template === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path || 'root'} must be an object`);
      return errors;
    }
    const t = template as Record<string, unknown>;
    const v = value as Record<string, unknown>;
    for (const key of Object.keys(t)) {
      if (!(key in v)) errors.push(`missing ${path}${key}`);
      else errors.push(...validateShape(v[key], t[key], `${path}${key}.`));
    }
    for (const key of Object.keys(v)) {
      if (!(key in t)) errors.push(`unknown key ${path}${key}`);
    }
    return errors;
  }
  const expected = typeof template;
  const p = path.replace(/\.$/, '');
  if (typeof value !== expected) {
    errors.push(`${p} must be a ${expected}`);
  } else if (expected === 'number' && !Number.isFinite(value as number)) {
    errors.push(`${p} must be a finite number`);
  }
  return errors;
}

export function parseThresholds(text: string): { value?: Thresholds; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { errors: [`Invalid JSON: ${errorMessage(err)}`] };
  }
  const errors = validateShape(parsed, DEFAULT_THRESHOLDS, '');
  if (errors.length > 0) return { errors };
  return { value: parsed as Thresholds, errors: [] };
}

function pretty(t: Thresholds): string {
  return JSON.stringify(t, null, 2);
}

export function SettingsPage(): JSX.Element {
  const [form, setForm] = useState<FormState | undefined>();
  const [thresholdsText, setThresholdsText] = useState('');
  const [thresholdErrors, setThresholdErrors] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [saveError, setSaveError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [health, setHealth] = useState<string | undefined>();

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        setForm(toForm(s.analysis));
        setThresholdsText(pretty(s.thresholds));
      })
      .catch((err) => setLoadError(errorMessage(err)));
    api
      .health()
      .then((h) => setHealth(h.ok ? h.engine : `engine unavailable (${h.engine})`))
      .catch(() => setHealth(undefined));
  }, []);

  const set = (key: keyof FormState, value: string) => {
    setForm((f) => (f === undefined ? f : { ...f, [key]: value }));
    setSaved(false);
  };

  const onThresholdsChange = (text: string) => {
    setThresholdsText(text);
    setThresholdErrors(parseThresholds(text).errors);
    setSaved(false);
  };

  const resetThresholds = () => {
    setThresholdsText(pretty(DEFAULT_THRESHOLDS));
    setThresholdErrors([]);
    setSaved(false);
  };

  const formatThresholds = () => {
    const res = parseThresholds(thresholdsText);
    if (res.value !== undefined) setThresholdsText(pretty(res.value));
    setThresholdErrors(res.errors);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (form === undefined) return;
    setSaveError(undefined);
    setSaved(false);
    let analysis: AnalysisSettings;
    try {
      analysis = fromForm(form);
    } catch (err) {
      setSaveError(errorMessage(err));
      return;
    }
    const th = parseThresholds(thresholdsText);
    if (th.value === undefined) {
      setThresholdErrors(th.errors);
      setSaveError('Fix the thresholds JSON before saving.');
      return;
    }
    setSaving(true);
    api
      .updateSettings({ analysis, thresholds: th.value })
      .then((s) => {
        setForm(toForm(s.analysis));
        setThresholdsText(pretty(s.thresholds));
        setThresholdErrors([]);
        setSaved(true);
      })
      .catch((err) => setSaveError(errorMessage(err)))
      .finally(() => setSaving(false));
  };

  if (loadError !== undefined) {
    return (
      <div>
        <div className="page-header">
          <h1>Settings</h1>
        </div>
        <div className="alert error">{loadError}</div>
      </div>
    );
  }

  if (form === undefined) return <div className="empty">Loading settings…</div>;

  const depthNum = Number(form.depth);
  const usingMovetime = form.movetimeMs.trim() !== '';

  return (
    <div>
      <div className="page-header">
        <h1>Settings</h1>
        {health !== undefined && <span className="muted small">Engine: {health}</span>}
      </div>

      <form onSubmit={onSubmit}>
        <div className="card">
          <h2>Engine</h2>

          <div className="field">
            <label htmlFor="depth">Search depth</label>
            <div className="inline" style={{ flexWrap: 'wrap' }}>
              <span className="preset-row">
                {DEPTH_PRESETS.map((d) => (
                  <button
                    type="button"
                    key={d}
                    className={`btn small${depthNum === d ? ' on' : ''}`}
                    onClick={() => set('depth', String(d))}
                  >
                    {d}
                  </button>
                ))}
              </span>
              <input
                id="depth"
                type="number"
                min={1}
                max={99}
                value={form.depth}
                style={{ width: 90 }}
                onChange={(e) => set('depth', e.target.value)}
              />
              {usingMovetime && <span className="hint">ignored while movetime is set</span>}
            </div>
            <span className="hint">18 is quick, 20 is balanced, 24 is thorough (several seconds per move).</span>
          </div>

          <div className="form-grid">
            <div className="field">
              <label htmlFor="multiPv">MultiPV</label>
              <input id="multiPv" type="number" min={1} max={10} value={form.multiPv} onChange={(e) => set('multiPv', e.target.value)} />
              <span className="hint">At least 2 is needed for Great / Brilliant detection.</span>
            </div>
            <div className="field">
              <label htmlFor="threads">Threads</label>
              <input id="threads" type="number" min={1} max={256} value={form.threads} onChange={(e) => set('threads', e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="hashMb">Hash (MB)</label>
              <input id="hashMb" type="number" min={1} max={65536} value={form.hashMb} onChange={(e) => set('hashMb', e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="movetime">Movetime (ms, optional)</label>
              <input
                id="movetime"
                type="number"
                min={1}
                value={form.movetimeMs}
                placeholder="use depth"
                onChange={(e) => set('movetimeMs', e.target.value)}
              />
              <span className="hint">When set, the engine searches for this long per position instead of to a depth.</span>
            </div>
          </div>

          <div className="field">
            <label htmlFor="enginePath">Engine path</label>
            <input
              id="enginePath"
              type="text"
              value={form.enginePath}
              spellCheck={false}
              onChange={(e) => set('enginePath', e.target.value)}
            />
            <span className="hint">Absolute, or relative to the project root (default engines/stockfish).</span>
          </div>
        </div>

        <div className="card">
          <div className="inline" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Classification thresholds</h2>
            <span className="btn-group">
              <button type="button" className="btn small" onClick={formatThresholds}>
                Format
              </button>
              <button type="button" className="btn small" onClick={resetThresholds}>
                Reset to defaults
              </button>
            </span>
          </div>
          <textarea
            rows={28}
            value={thresholdsText}
            spellCheck={false}
            style={{ width: '100%' }}
            onChange={(e) => onThresholdsChange(e.target.value)}
          />
          {thresholdErrors.length > 0 && (
            <div className="alert error">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {thresholdErrors.slice(0, 12).map((e) => (
                  <li key={e}>{e}</li>
                ))}
                {thresholdErrors.length > 12 && <li>…and {thresholdErrors.length - 12} more</li>}
              </ul>
            </div>
          )}
          <div className="hint" style={{ marginTop: 8 }}>
            Win-probability losses are 0..1 (0.05 = five percentage points). Changing thresholds does not re-run
            existing analyses.
          </div>
        </div>

        {saveError !== undefined && <div className="alert error">{saveError}</div>}
        {saved && <div className="alert success">Settings saved.</div>}

        <div className="btn-group" style={{ marginTop: 16 }}>
          <button className="btn primary" type="submit" disabled={saving || thresholdErrors.length > 0}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </div>
  );
}
