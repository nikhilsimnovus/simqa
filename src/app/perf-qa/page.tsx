'use client';

import { useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { Card, CardBody, Badge, Button } from '@/components/ui';
import { ExternalLink, RefreshCw, AlertTriangle } from 'lucide-react';

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

      <div className="px-6 pt-4 pb-3 flex items-center gap-3 flex-wrap">
        <Badge tone={reachable === 'ok' ? 'success' : reachable === 'down' ? 'danger' : 'default'}>
          {reachable === 'ok' ? '● collector reachable'
            : reachable === 'down' ? '● collector unreachable'
            : '○ checking…'}
        </Badge>
        <span className="text-xs text-slate-500 font-mono">{url}</span>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setIframeKey(k => k + 1)}>
            <RefreshCw className="h-4 w-4" /> Reload
          </Button>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary-700 hover:underline"
          >
            Open in new tab <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      {reachable === 'down' && (
        <div className="px-6 pb-3">
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

      <div className="flex-1 px-6 pb-6 min-h-0">
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
