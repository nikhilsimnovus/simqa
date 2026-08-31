// Workspace settings — the knobs the Settings page edits.
//
// Storage is data/settings.json (gitignored, like every other runtime
// artifact). Everything has a default, so the file is optional and partial:
// a missing or hand-deleted file just means "stock behavior", and unknown
// keys from a newer build are preserved on save rather than dropped —
// the same round-trip rule inventory.yaml follows.
//
// Reads are hot-path (uesimClient consults timeouts on every API call), so
// the file is cached by mtime rather than re-parsed per call.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Settings {
  /** Milliseconds before a UESIM REST GET is abandoned. */
  uesimGetTimeoutMs: number;
  /** Milliseconds before a UESIM REST POST is abandoned. Generous by
   *  default — execution start legitimately runs long on some builds. */
  uesimPostTimeoutMs: number;
  /** End-to-end runner: how often to poll execution status. */
  runnerPollIntervalMs: number;
  /** End-to-end runner: how long to wait for completion after the
   *  testcase's configured duration elapses. */
  runnerCompletionGraceMs: number;
  /** Webhook fired when a run finishes. Slack-compatible: the payload is
   *  {text} plus a structured `run` object for generic receivers. Empty
   *  string = notifications off. */
  notifyWebhookUrl: string;
  /** Fire the webhook for passing runs too, not only failures. */
  notifyOnSuccess: boolean;
}

export const SETTINGS_DEFAULTS: Settings = {
  uesimGetTimeoutMs: 20_000,
  uesimPostTimeoutMs: 120_000,
  runnerPollIntervalMs: 5_000,
  runnerCompletionGraceMs: 5 * 60_000,
  notifyWebhookUrl: '',
  notifyOnSuccess: false,
};

/** Bounds applied on save AND on load — a hand-edited file can't push a
 *  timeout to 0 and break every request, or to an hour and hang the UI. */
const CLAMPS: Record<keyof Settings, [number, number] | null> = {
  uesimGetTimeoutMs: [2_000, 120_000],
  uesimPostTimeoutMs: [5_000, 600_000],
  runnerPollIntervalMs: [1_000, 60_000],
  runnerCompletionGraceMs: [0, 60 * 60_000],
  notifyWebhookUrl: null,
  notifyOnSuccess: null,
};

export function settingsPath(): string {
  return path.join(process.cwd(), 'data', 'settings.json');
}

function sanitize(raw: Record<string, unknown>): Settings {
  const out: any = { ...SETTINGS_DEFAULTS };
  for (const k of Object.keys(SETTINGS_DEFAULTS) as (keyof Settings)[]) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    const clamp = CLAMPS[k];
    if (clamp) {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = Math.min(clamp[1], Math.max(clamp[0], Math.round(n)));
    } else if (typeof SETTINGS_DEFAULTS[k] === 'boolean') {
      out[k] = !!v;
    } else {
      out[k] = String(v);
    }
  }
  return out as Settings;
}

let cache: { mtimeMs: number; value: Settings } | null = null;

/** Effective settings: file merged over defaults, mtime-cached. */
export function getSettings(): Settings {
  const p = settingsPath();
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(p).mtimeMs;
  } catch {
    cache = null;
    return { ...SETTINGS_DEFAULTS };
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache.value;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    cache = { mtimeMs, value: sanitize(parsed) };
    return cache.value;
  } catch {
    // Unparseable file — behave, don't throw. The page will show defaults
    // and the next save rewrites it cleanly.
    return { ...SETTINGS_DEFAULTS };
  }
}

/** Raw file content (for round-tripping unknown keys), or {} if none. */
export function loadSettingsRaw(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function saveSettings(patch: Record<string, unknown>): Settings {
  const p = settingsPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Unknown keys survive; known keys are sanitized on the way in.
  const merged = { ...loadSettingsRaw(), ...patch };
  const clean = sanitize(merged);
  const out = { ...merged, ...clean };
  fs.writeFileSync(p, JSON.stringify(out, null, 2) + '\n', 'utf8');
  cache = null;
  return clean;
}
