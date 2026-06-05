'use client';

import { useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { Card, CardBody, Badge, Button } from '@/components/ui';
import { ExternalLink, RefreshCw, AlertTriangle, Package } from 'lucide-react';

// Perf QA tab — embeds the standalone Flask UI that runs the perf-data
// collector on the QA collector host. The source for that Flask app + the
// bash collector + analyzer all live alongside this file in the simqa repo
// under perf-qa/ (see perf-qa/README.md for deploy steps).
//
// We don't re-implement the collector here in TS — the Flask app already
// handles SSE log streaming, profile management, and bundle inspection. An
// iframe is the smallest correct integration; the URL is configurable in
// case the host moves.
const DEFAULT_PERF_QA_URL = 'http://192.168.1.36:4000';
const STORAGE_KEY = 'simqa.perfQaUrl';

export default function PerfQaPage() {
  // Resolve the perf-qa host: env override → localStorage → default. The
  // env hook lets a deploy point this at a different collector without a
  // code change; the localStorage hook lets a developer override per-browser.
  const [url, setUrl] = useState<string>(DEFAULT_PERF_QA_URL);
  const [reachable, setReachable] = useState<'unknown' | 'ok' | 'down'>('unknown');
  const [iframeKey, setIframeKey] = useState(0); // bump to force iframe reload

  useEffect(() => {
    const cached = typeof window !== 'undefined'
      ? window.localStorage.getItem(STORAGE_KEY)
      : null;
    if (cached) setUrl(cached);
  }, []);

  // Light reachability probe so we can show a "Flask UI down" hint instead
  // of just a blank iframe. fetch with no-cors so cross-origin doesn't throw;
  // any successful response (even an opaque one) means TCP is up.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await fetch(`${url}/favicon.png`, { mode: 'no-cors', cache: 'no-store' });
        if (!cancelled) setReachable('ok');
      } catch {
        if (!cancelled) setReachable('down');
      }
    })();
    return () => { cancelled = true; };
  }, [url, iframeKey]);

  return (
    <div className="flex flex-col h-full">
      <Header
        title="Perf QA"
        subtitle="One-click diagnostics for a perf-test run — collector + analyzer + bundle inspector"
      />

      {/* The status banner used to always show "● collector reachable" +
          the URL. When the iframe is rendering normally that's just noise —
          the iframe IS the proof. Show the banner ONLY when the collector
          is unreachable (with a useful error). When everything's fine we
          keep just a tiny corner action so Reload + Open-in-new-tab stay
          one click away. */}
      {reachable === 'down' && (
        <div className="px-6 pt-4 pb-3">
          <Card>
            <CardBody>
              <div className="flex items-start gap-3 text-sm">
                <AlertTriangle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-slate-900">Perf QA collector is unreachable at {url}</div>
                  <div className="text-slate-600 mt-1">
                    Check that the <code className="px-1 bg-slate-100 rounded">perf-qa-ui</code> service is running on the collector host:
                    <pre className="mt-2 text-xs bg-slate-900 text-slate-100 p-3 rounded">ssh sysadmin@{url.replace(/^https?:\/\//, '').replace(/:\d+$/, '')} 'sudo systemctl status perf-qa-ui'</pre>
                    Source + deploy steps: <code className="px-1 bg-slate-100 rounded">perf-qa/README.md</code> at the repo root.
                  </div>
                </div>
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      <div className="flex-1 px-6 pt-3 pb-6 min-h-0 relative">
        {/* Minimal corner toolbar — only the actions, no status chatter.
            Two Deploy build buttons:
              · Slim (~85 KB): default — source + installer, no browsers.
                For re-installs / updates where the Playwright cache is
                already on the host.
              · + browsers (~267 MB): opt-in — same plus pre-staged
                Chromium for offline customer installs. Needs the simqa
                host to have run perf-qa/scripts/fetch-vendor.sh first. */}
        <div className="absolute top-3 right-9 z-10 flex items-center gap-1 bg-white/85 backdrop-blur rounded-md border border-slate-200 shadow-sm px-1 py-0.5">
          <a
            href="/api/perf-qa/deploy-build"
            download
            className="inline-flex items-center gap-1 text-xs text-primary-700 hover:bg-primary-50 px-2 py-1 rounded font-medium"
            title="~90 KB. For customers that ALREADY have perf-qa installed — re-running install.sh detects existing Chromium and skips the download."
          >
            <Package className="h-3.5 w-3.5" /> Update
          </a>
          <a
            href="/api/perf-qa/deploy-build?vendor=1"
            download
            className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-primary-700 hover:bg-primary-50 px-2 py-1 rounded"
            title="~267 MB. For FIRST-TIME installs at a new customer site — includes bundled Playwright Chromium so the install never reaches out for the browser download."
          >
            <Package className="h-3.5 w-3.5" /> Fresh install
          </a>
          <span className="w-px h-4 bg-slate-200 mx-1" />
          <Button size="sm" variant="ghost" onClick={() => setIframeKey(k => k + 1)} title="Reload the embedded UI">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-primary-700 px-2 py-1 rounded"
            title="Open the Flask UI in a new tab"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
        <Card className="h-full overflow-hidden">
          <iframe
            key={iframeKey}
            src={url}
            title="Perf QA collector"
            className="w-full h-full border-0"
            // Sandbox allows the Flask UI to run scripts, submit forms,
            // open new windows for "Open in new tab" downloads, and use
            // EventSource for the live log stream. Same-origin lets it
            // talk to its own backend endpoints.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads"
          />
        </Card>
      </div>
    </div>
  );
}
