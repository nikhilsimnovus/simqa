// The shapes a Simnovator execution read comes back in.
//
// Split from executionReads.ts, which has to reach the network and therefore
// drags in the whole uesimClient import chain. These are the parts worth
// testing, so they live where node --test can load them directly: pure,
// importing nothing.

/** The statistics the box serves, by the slug it serves them under. */
export const STAT_KINDS = ['global', 'cells', 'ues', 'ue-summary'] as const;
export type StatKind = typeof STAT_KINDS[number];

/**
 * Log payloads differ by build: an array of strings, an array of objects with
 * a message field, or one blob with newlines. Flattened to lines so the viewer
 * does not have to care, and so searching and exporting work the same either
 * way.
 */
export function logLines(data: unknown): string[] {
  if (data === undefined || data === null) return [];
  if (typeof data === 'string') return data.split(/\r?\n/);
  if (Array.isArray(data)) {
    return data.map((x) => {
      if (typeof x === 'string') return x;
      if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        const msg = o.message ?? o.msg ?? o.line ?? o.text;
        if (typeof msg === 'string') {
          const at = o.timestamp ?? o.time ?? o.ts;
          const lvl = o.level ?? o.severity;
          return [at, lvl, msg].filter(Boolean).join(' ');
        }
      }
      return JSON.stringify(x);
    });
  }
  if (typeof data === 'object') {
    const o = data as Record<string, unknown>;
    for (const key of ['logs', 'lines', 'items', 'data', 'content']) {
      if (key in o) return logLines(o[key]);
    }
  }
  return [JSON.stringify(data)];
}
