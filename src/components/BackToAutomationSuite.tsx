'use client';

// "← Back to Automation Suites", shown on a testcase's report page when the
// user arrived by clicking a row in a suite.
//
// Same contract as BackToRunHistory and BackToDashboard: it renders only when
// the URL carries ?from=automation-suite, so a report opened any other way
// keeps its normal header. Going back uses history.back() when the previous
// entry really is the suite page — which restores its scroll position and the
// cards it had expanded — and falls back to a plain push for a link that was
// shared or bookmarked.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

export function BackToAutomationSuite() {
  const router = useRouter();
  const [show, setShow] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);

  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      setShow(sp.get('from') === 'automation-suite');
      const ref = typeof document !== 'undefined' ? document.referrer : '';
      let fromSuite = false;
      try { fromSuite = !!ref && new URL(ref).pathname === '/automation-suite'; } catch { /* not a URL */ }
      setCanGoBack(fromSuite);
    } catch { /* SSR / no window */ }
  }, []);

  if (!show) return null;

  return (
    <button
      onClick={() => { if (canGoBack) router.back(); else router.push('/automation-suite'); }}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-700 hover:text-primary-800 hover:underline"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      Back to Automation Suites
    </button>
  );
}
