// The HTML report, in the shape Pradeep's own tool produces.
//
// Structure, stylesheet, toolbar and filtering script are taken from that
// report so the two are interchangeable: a reader who knows one knows this.
// What differs is only the data, which is SimQA's.
//
// Everything is in one file — no fonts, scripts or styles fetched — so it
// opens the same on any machine, mails as a single attachment, and prints to
// PDF with every visible row expanded.

type Json = any;

interface Entry {
  n: number;
  section: string;
  method: string;
  path: string;
  summary: string;
  case: string;
  kind: string;
  expect: string[];
  status: number | null;
  verdict: string | null;
  reason: string;
  note: string;
  info: string;
  issues: Array<{ label: string; detail: string }>;
  warnings: Array<{ label: string; detail: string }>;
  ms: number | null;
  request: Json;
  response: Json;
  documented: Record<string, string>;
  as: string;
}

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const slug = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * The right-hand group: which check this is, what it expected, what came back
 * and how long it took.
 *
 *   #1 · expected 200 → 200 · 42 ms
 *
 * The expectation is the half a bare status code leaves out: "400" says what
 * the server answered and nothing about whether that was the right answer.
 */
function codes(e: Entry): string {
  const want = (e.expect ?? []).filter(Boolean);
  const got = e.status === null || e.status === undefined ? '—' : String(e.status);
  const bits = [`#${e.n}`];
  bits.push(want.length ? `expected ${want.join('/')} → ${got}` : got);
  if (e.ms !== null && e.ms !== undefined) bits.push(`${e.ms} ms`);
  return `<span class="codes">${esc(bits.join(' · '))}</span>`;
}

function headersTable(h: Json): string {
  const rows = Object.entries(h ?? {});
  if (!rows.length) return '';
  return `<h4>Headers</h4><table class="hdrs">${
    rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')
  }</table>`;
}

function entryHtml(e: Entry): string {
  const v = String(e.verdict ?? 'SKIP').toUpperCase();
  const req = e.request ?? {};
  const res = e.response ?? {};
  const docs = Object.entries(e.documented ?? {});

  return `
    <details class="r v-${esc(v)}" data-v="${esc(v)}" data-k="${esc(e.kind)}" data-n="${e.note ? 1 : 0}" data-w="${e.warnings.length ? 1 : 0}">
      <summary>
        <span class="pill ${esc(v)}">${esc(v)}</span>
        <span class="m ${esc(e.method)}">${esc(e.method)}</span>
        <span class="path">${esc(e.path)}</span>
        ${e.kind ? `<span class="kind">${esc(e.kind)}</span>` : ''}
        ${e.as ? `<span class="kind">as ${esc(e.as)}</span>` : ''}
        <span class="case">${esc(e.case)}</span>
        ${e.note ? '<span class="kind doc-err">documented error</span>' : ''}
        ${e.warnings.length ? `<span class="kind">${e.warnings.length} warning(s)</span>` : ''}
        ${codes(e)}
      </summary>
      <div class="body">
        ${e.summary ? `<p class="muted">${esc(e.summary)}</p>` : ''}
        ${e.reason ? `<p class="reason">${esc(e.reason)}</p>` : ''}
        ${e.note ? `<p class="note">${esc(e.note)}</p>` : ''}
        ${e.info ? `<p class="muted">${esc(e.info)}</p>` : ''}
        ${e.issues.length ? `<ul class="issues">${e.issues.map(i => `<li><b>${esc(i.label)}</b> ${esc(i.detail)}</li>`).join('')}</ul>` : ''}
        ${e.warnings.length ? `<ul class="issues warn">${e.warnings.map(w => `<li><b>${esc(w.label)}</b> ${esc(w.detail)}</li>`).join('')}</ul>` : ''}
        ${docs.length ? `<div class="doc"><b>Documented responses:</b>
          ${docs.map(([c, d]) => `<span class="${String(e.status ?? '') === c ? 'hit' : ''}" title="${esc(d)}">${esc(c)}</span>`).join('')}
        </div>` : ''}
        <div class="cols">
          <div>
            <h4>Request</h4>
            <pre>${esc(`${req.method ?? ''} ${req.url ?? ''}`.trim())}</pre>
            ${req.curl ? `<h4>curl <button class="copy" data-copy>copy</button></h4><pre>${esc(req.curl)}</pre>` : ''}
            ${headersTable(req.headers)}
            ${req.body ? `<h4>Body</h4><pre>${esc(req.body)}</pre>` : ''}
          </div>
          <div>
            <h4>Response</h4>
            <pre>${res.status !== undefined && res.status !== null
              ? esc(`HTTP ${res.status} ${res.reason ?? ''}`.trim())
              : 'no response'}</pre>
            ${headersTable(res.headers)}
            ${res.body ? `<h4>Body</h4><pre>${esc(res.body)}</pre>` : ''}
          </div>
        </div>
      </div>
    </details>`;
}

export function renderReport(data: Json): string {
  const m = data.meta ?? {};
  const s = data.summary ?? {};
  const results: Entry[] = (data.results ?? []) as Entry[];
  const counts = s.counts ?? {};
  const n = (k: string) => Number(counts[k] ?? 0);
  const total = Number(s.total ?? results.length) || 0;
  const pct = (x: number) => (total ? (x / total) * 100 : 0);

  const bySection = new Map<string, Entry[]>();
  for (const e of results) {
    const arr = bySection.get(e.section) ?? [];
    arr.push(e);
    bySection.set(e.section, arr);
  }

  const tile = (label: string, value: Json, cls = '') =>
    `<div class="tile ${cls}"><div class="n">${esc(value ?? 0)}</div><div>${esc(label)}</div></div>`;

  const sectionRows = [...bySection.entries()].map(([name, list]) => {
    const c = (v: string) => list.filter(e => String(e.verdict).toUpperCase() === v).length;
    return `<tr>
      <td><a href="#sec-${esc(slug(name))}">${esc(name)}</a></td>
      <td class="num">${list.length}</td>
      <td class="num">${c('PASS')}</td>
      <td class="num">${c('FAIL')}</td>
      <td class="num">${c('SKIP')}</td>
      <td class="num">${c('ERROR')}</td>
    </tr>`;
  }).join('');

  const specIssues = Object.entries((data.spec_issues ?? {}) as Record<string, string[]>)
    .map(([api, list]) => `<details><summary>${esc(api)} <span class="muted">${list.length}</span></summary><ul>${
      list.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>`)
    .join('') || '<p class="muted">No documented example breaks its own schema for the APIs in this run.</p>';

  const sections = [...bySection.entries()].map(([name, list]) => `
    <h3 class="sec" id="sec-${esc(slug(name))}">${esc(name)}</h3>
    ${list.map(entryHtml).join('')}`).join('');

  const notes = (data.notes ?? []) as string[];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(m.tool ?? 'API validation')} — ${esc(m.run_id ?? '')}</title>
<style>
  :root {
    --bg: #f5f7fa; --card: #fff; --ink: #1c2430; --muted: #5d6b7c; --line: #dde3ea;
    --pass: #1a7f45; --pass-bg: #e3f5ea; --fail: #c62828; --fail-bg: #fdecea;
    --skip: #5d6b7c; --skip-bg: #eef1f4; --err: #a15c00; --err-bg: #fff3dc; --accent: #1f5fae;
    --code-bg: #f0f3f7;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { background: #13293d; color: #fff; padding: 20px 24px; }
  header h1 { margin: 0; font-size: 22px; }
  header p { margin: 4px 0 0; color: #b8c7d6; }
  main { max-width: 1200px; margin: 0 auto; padding: 20px 16px 60px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; margin-bottom: 16px; }
  .card h2 { margin: 0 0 12px; font-size: 16px; }
  .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 6px 20px; }
  .meta div span { color: var(--muted); display: block; font-size: 12px; }
  .meta div b { overflow-wrap: anywhere; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
  .tile { border-radius: 8px; padding: 10px 12px; background: var(--skip-bg); }
  .tile .n { font-size: 26px; font-weight: 700; }
  .tile.pass { background: var(--pass-bg); color: var(--pass); } .tile.fail { background: var(--fail-bg); color: var(--fail); }
  .tile.err, .tile.warn { background: var(--err-bg); color: var(--err); }
  .issues.warn li { background: var(--err-bg); }
  .bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; margin: 14px 0 4px; background: var(--skip-bg); }
  .bar i { display: block; } .bar .p { background: var(--pass); } .bar .f { background: var(--fail); } .bar .e { background: var(--err); } .bar .s { background: #b4bfcc; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill { display: inline-block; min-width: 44px; text-align: center; padding: 1px 8px; border-radius: 10px; font-size: 12px; font-weight: 700; }
  .PASS { background: var(--pass-bg); color: var(--pass); } .FAIL { background: var(--fail-bg); color: var(--fail); }
  .SKIP { background: var(--skip-bg); color: var(--skip); } .ERROR { background: var(--err-bg); color: var(--err); }
  .m { display: inline-block; min-width: 58px; text-align: center; font: 700 11px/18px ui-monospace, monospace; border-radius: 4px; color: #fff; }
  .m.GET { background: #1f6fd1; } .m.POST { background: #1a8f55; } .m.PUT { background: #c07b00; } .m.PATCH { background: #7b4bc4; } .m.DELETE { background: #c62828; } .m.WAIT { background: #8a96a3; }
  .kind { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; }
  .kind.doc-err { color: var(--err); border-color: #f0c77a; background: var(--err-bg); }
  .toolbar { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; background: var(--bg); padding: 10px 0; }
  .toolbar button, .toolbar select, .toolbar input { font: inherit; padding: 5px 10px; border: 1px solid var(--line); border-radius: 6px; background: #fff; cursor: pointer; }
  .toolbar button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  .toolbar input { cursor: text; min-width: 200px; flex: 1; }
  h3.sec { margin: 22px 0 8px; font-size: 15px; text-transform: capitalize; }
  details.r { background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--skip); border-radius: 8px; margin-bottom: 6px; }
  /* The row's own colour, by verdict: light green passed, light red failed,
     grey skipped, amber errored. */
  details.r.v-PASS { border-left-color: var(--pass); background: var(--pass-bg); }
  details.r.v-FAIL { border-left-color: var(--fail); background: var(--fail-bg); }
  details.r.v-SKIP { border-left-color: var(--skip); background: var(--skip-bg); }
  details.r.v-ERROR { border-left-color: var(--err); background: var(--err-bg); }
  details.r > summary { cursor: pointer; padding: 8px 12px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; list-style: none; }
  details.r > summary::-webkit-details-marker { display: none; }
  .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; word-break: break-all; }
  .case { color: var(--muted); }
  .codes { margin-left: auto; font-family: ui-monospace, monospace; font-size: 12px; color: var(--muted); white-space: nowrap; }
  .body { padding: 4px 14px 14px; border-top: 1px solid var(--line); background: var(--card); border-radius: 0 0 6px 6px; }
  .issues { margin: 10px 0; padding: 0; list-style: none; }
  .issues li { background: var(--fail-bg); border-radius: 6px; padding: 6px 10px; margin-bottom: 4px; word-break: break-word; }
  .issues li b { font-size: 11px; letter-spacing: .03em; margin-right: 6px; }
  .reason { background: var(--skip-bg); border-radius: 6px; padding: 6px 10px; margin: 10px 0; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 800px) { .cols { grid-template-columns: 1fr; } .codes { margin-left: 0; } }
  h4 { margin: 12px 0 6px; font-size: 13px; }
  pre { background: var(--code-bg); border-radius: 6px; padding: 8px 10px; margin: 0; max-height: 420px; overflow: auto; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
  .hdrs { font-size: 12px; } .hdrs td { padding: 2px 6px; font-family: ui-monospace, monospace; word-break: break-all; }
  .doc span { display: inline-block; font: 12px ui-monospace, monospace; padding: 1px 6px; margin: 2px; border-radius: 4px; background: var(--code-bg); }
  .doc span.hit { outline: 2px solid var(--accent); }
  .muted { color: var(--muted); }
  .note { background: var(--err-bg); border-radius: 6px; padding: 6px 10px; margin-bottom: 4px; }
  .copy { font-size: 11px; padding: 1px 8px; border: 1px solid var(--line); border-radius: 4px; background: #fff; cursor: pointer; margin-left: 6px; }
  .hidden { display: none !important; }
  @media print {
    body { background: #fff; } header { background: #fff; color: #000; border-bottom: 2px solid #000; } header p { color: #333; }
    .toolbar, .copy { display: none !important; } .card, details.r { break-inside: avoid; } pre { max-height: none; }
  }
</style>
</head>
<body>
<header>
  <h1>${esc(m.tool ?? 'API validation')}</h1>
  <p>Run ${esc(m.run_id ?? '')} · ${esc(m.started ?? '')} → ${esc(m.finished ?? '')}${m.duration ? ` (${esc(m.duration)})` : ''}</p>
</header>
<main>

  <section class="card">
    <h2>Run details</h2>
    <div class="meta">
      <div><span>Run as</span><b>${esc(m.run_as ?? '—')}</b></div>
      <div><span>Server</span><b>${esc(m.host ?? '—')}</b></div>
      <div><span>Base URL</span><b>${esc(m.base_url ?? '—')}</b></div>
      <div><span>Login</span><b>${esc(m.user ?? '—')}</b></div>
      <div><span>Document</span><b>${esc(m.spec_title ?? '')} ${esc(m.spec_version ?? '')}</b></div>
      <div><span>Fingerprint</span><b>${esc(m.spec_fingerprint ?? '—')}</b></div>
      <div><span>Server version</span><b>${esc(m.server_version ?? '—')}</b></div>
      <div><span>APIs selected</span><b>${esc(m.apis_selected ?? '—')}</b></div>
      <div><span>Negative tests</span><b>${m.negative ? 'on' : 'off'}</b></div>
      <div><span>Strict status codes</span><b>${m.strict_status ? 'on' : 'off'}</b></div>
      <div><span>Safety check</span><b>${m.safety ? 'on' : '<span style="color:#c62828">OFF</span>'}</b></div>
      ${m.suite ? `<div><span>Full API suite</span><b>user ${esc(m.suite_user ?? '')}, UE ${esc(m.suite_ue_ip ?? '—')}</b></div>` : ''}
    </div>
  </section>

  <section class="card">
    <h2>Summary — ${esc(s.pass_rate ?? 0)}% of executed checks passed</h2>
    <div class="tiles">
      ${tile('Total', total)}
      ${tile('Passed', n('PASS'), 'pass')}
      ${tile('Failed', n('FAIL'), 'fail')}
      ${tile('Skipped', n('SKIP'))}
      ${tile('Errors', n('ERROR'), 'err')}
      ${tile('Documented errors', s.documented_errors ?? 0, 'warn')}
      ${tile('With warnings', s.warned ?? 0, 'warn')}
    </div>
    <div class="bar">
      <i class="p" style="width:${pct(n('PASS')).toFixed(2)}%"></i>
      <i class="f" style="width:${pct(n('FAIL')).toFixed(2)}%"></i>
      <i class="e" style="width:${pct(n('ERROR')).toFixed(2)}%"></i>
      <i class="s" style="width:${pct(n('SKIP')).toFixed(2)}%"></i>
    </div>
  </section>

  <section class="card">
    <h2>By section</h2>
    <table>
      <thead><tr><th>Section</th><th class="num">Checks</th><th class="num">Pass</th><th class="num">Fail</th><th class="num">Skip</th><th class="num">Error</th></tr></thead>
      <tbody>${sectionRows}</tbody>
    </table>
  </section>

  ${notes.length ? `<section class="card"><h2>Notes</h2><ul>${notes.map(x => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}

  <section class="card">
    <h2>Document self-check</h2>
    <p class="muted">Documented examples that break their own schema, judged by the same rules as the run. These usually mean the document is inconsistent, not the server.</p>
    ${specIssues}
  </section>

  <div class="toolbar">
    <button data-f="all" class="on">All</button>
    <button data-f="FAIL">Failed</button>
    <button data-f="PASS">Passed</button>
    <button data-f="SKIP">Skipped</button>
    <button data-f="ERROR">Errors</button>
    <button data-f="NOTE">Documented errors</button>
    <button data-f="WARN">Warnings</button>
    <select id="kind"><option value="">Positive + negative</option><option value="positive">Positive only</option><option value="negative">Negative only</option><option value="setup">Setup steps</option></select>
    <input id="q" type="search" placeholder="Search path, case, message…">
    <button id="expand">Expand all</button>
    <button id="collapse">Collapse all</button>
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>

  ${sections}

  <p class="muted" style="margin-top:20px">${esc(m.tool ?? '')} · document ${esc(m.spec_fingerprint ?? '')} · generated ${esc(m.finished ?? '')}</p>
</main>
<script>
  const rows = [...document.querySelectorAll('details.r')];
  let verdict = 'all';
  function apply() {
    const q = document.getElementById('q').value.toLowerCase(), kind = document.getElementById('kind').value;
    rows.forEach(r => r.classList.toggle('hidden',
      (verdict === 'NOTE' ? r.dataset.n !== '1' : verdict === 'WARN' ? r.dataset.w !== '1' : verdict !== 'all' && r.dataset.v !== verdict) || (kind && r.dataset.k !== kind) ||
      (q && !r.textContent.toLowerCase().includes(q))));
    document.querySelectorAll('h3.sec').forEach(h => {
      let n = h.nextElementSibling, any = false;
      while (n && n.tagName === 'DETAILS') { any = any || !n.classList.contains('hidden'); n = n.nextElementSibling; }
      h.classList.toggle('hidden', !any);
    });
  }
  document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
    document.querySelectorAll('[data-f]').forEach(x => x.classList.toggle('on', x === b));
    verdict = b.dataset.f; apply();
  });
  document.getElementById('q').oninput = apply;
  document.getElementById('kind').onchange = apply;
  document.getElementById('expand').onclick = () => rows.forEach(r => { if (!r.classList.contains('hidden')) r.open = true; });
  document.getElementById('collapse').onclick = () => rows.forEach(r => r.open = false);
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = e => {
    e.preventDefault();
    navigator.clipboard.writeText(b.closest('h4').nextElementSibling.textContent).then(() => { b.textContent = 'copied'; });
  });
  // Printing / Save-as-PDF includes everything currently visible, expanded.
  let wasOpen = [];
  addEventListener('beforeprint', () => { wasOpen = rows.map(r => r.open); rows.forEach(r => { if (!r.classList.contains('hidden')) r.open = true; }); });
  addEventListener('afterprint', () => rows.forEach((r, i) => r.open = wasOpen[i]));
</script>
</body>
</html>`;
}
