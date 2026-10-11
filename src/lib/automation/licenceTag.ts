// The licence tag a config asks the licence server for.
//
// Every enb/gnb, mme and ims config on the callboxes names one:
//
//   license_server: {server_addr: "192.168.0.11:9051", tag: "oran-enb"},
//
// and it decides which licence the component takes out. The lab's are
// rnd-enb, oran-enb, oru-enb, rnd-mme, mme-oran, oru-mme. Two setups sharing
// a licence server are told apart by it, so running a config captured from
// one on the other means changing the tag — until now a hand edit on the
// callbox before every such run.
//
// Found by scanning rather than by regex, for two reasons. `tag:` is a common
// enough key that a blind substitution would hit something else, and the
// spacing varies between real files: .107 writes
// `{server_addr: "…", tag: "oran-enb"}` while .106's gnb.cfg writes
// `{server_addr:"…",tag:"oru-enb"}`. Only the quoted value is replaced, so a
// rewritten config is byte-identical to the original apart from the tag.
//
// Pure, imports nothing, so node --test loads it directly.

/** Where a tag's VALUE sits in the text — the span between the quotes. */
interface TagSpan { start: number; end: number; value: string }

const isWord = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);

/**
 * The licence tag's value span, skipping strings, comments and preprocessor
 * lines.
 *
 * Only a LIVE `license_server` counts. The lab's configs carry commented-out
 * ones, and rewriting inside a comment would do nothing visible while
 * reporting success.
 */
function findTag(text: string): TagSpan | undefined {
  const n = text.length;
  let i = 0;

  /** Step over whatever is at `at` if it is not live code. Returns the index
   *  after it, or -1 when it was live code. */
  const skip = (at: number): number => {
    const c = text[at];
    if (c === '"') {
      let j = at + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      return j + 1;
    }
    if (c === '/' && text[at + 1] === '/') {
      let j = at;
      while (j < n && text[j] !== '\n') j++;
      return j;
    }
    if (c === '/' && text[at + 1] === '*') {
      let j = at + 2;
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
      return j + 2;
    }
    // A preprocessor directive, but only at the start of a line.
    if (c === '#') {
      let k = at - 1;
      while (k >= 0 && (text[k] === ' ' || text[k] === '\t')) k--;
      if (k < 0 || text[k] === '\n') {
        let j = at;
        while (j < n && text[j] !== '\n') j++;
        return j;
      }
    }
    return -1;
  };

  while (i < n) {
    const skipped = skip(i);
    if (skipped >= 0) { i = Math.max(skipped, i + 1); continue; }
    if (!text.startsWith('license_server', i) || isWord(text[i - 1]) || isWord(text[i + 14])) { i++; continue; }

    // Into its object, then find `tag` before that object closes.
    let j = i + 14;
    while (j < n && text[j] !== '{' && text[j] !== '\n') j++;
    if (text[j] !== '{') { i = j + 1; continue; }
    j++;
    let depth = 1;
    while (j < n && depth > 0) {
      const s = skip(j);
      if (s >= 0) { j = Math.max(s, j + 1); continue; }
      if (text[j] === '{') { depth++; j++; continue; }
      if (text[j] === '}') { depth--; j++; continue; }
      if (text.startsWith('tag', j) && !isWord(text[j - 1]) && !isWord(text[j + 3])) {
        let k = j + 3;
        while (k < n && /\s/.test(text[k])) k++;
        if (text[k] !== ':') { j += 3; continue; }
        k++;
        while (k < n && /\s/.test(text[k])) k++;
        if (text[k] !== '"') { j = k + 1; continue; }
        const start = k + 1;
        let e = start;
        while (e < n && text[e] !== '"') e += text[e] === '\\' ? 2 : 1;
        return { start, end: e, value: text.slice(start, e) };
      }
      j++;
    }
    i = j;
  }
  return undefined;
}

/** The licence tag this config asks for, or undefined when it names none. */
export function licenceTagOf(text: string): string | undefined {
  const span = findTag(text ?? '');
  return span ? span.value : undefined;
}

/**
 * The same config, asking for a different licence.
 *
 * Only the quoted tag changes — the server address, the spacing and every
 * other byte stay exactly as they were, so a config pushed with a new tag is
 * otherwise the file the operator captured.
 *
 * `changed` is false when the config already asks for that tag, and when it
 * names no licence server at all: there is nowhere to put one, and inventing
 * a `license_server` block would be guessing at a server address.
 */
export function withLicenceTag(text: string, tag: string): { text: string; changed: boolean; from?: string } {
  const span = findTag(text ?? '');
  if (!span) return { text, changed: false };
  if (span.value === tag) return { text, changed: false, from: span.value };
  return { text: text.slice(0, span.start) + tag + text.slice(span.end), changed: true, from: span.value };
}
