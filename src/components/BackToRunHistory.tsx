'use client';

// "← Back to Run History", shown on a surface's own page when the user
// arrived there by clicking Open on a Run History row.
//
// It renders ONLY when the URL carries ?from=runs, so the surfaces keep their
// normal appearance when reached through the sidebar. Going back uses
// history.back() when this page really was pushed from /runs, which restores
// the previous scroll position and — because the filters live in component
// state on that page — the filter selection along with it. It falls back to a
// plain push to /runs when there is no such history entry (a shared or
// bookmarked link), where a fresh, unfiltered Run History is the right
// landing place anyway.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

export function BackToRunHistory() {
  const router = useRouter();
  const [show, setShow] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);

  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      setShow(sp.get('from') === 'runs');
      // history.length > 1 alone is not evidence the previous entry is ours;
      // a same-origin referrer pointing at /runs is.
      setCanGoBack(typeof document !== 'undefined' && document.referrer.includes('/runs'));
    } catch { /* SSR / no window */ }
  }, []);

  if (!show) return null;

  return (
    <button
      onClick={() => { if (canGoBack) router.back(); else router.push('/runs'); }}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-700 hover:text-primary-800 hover:underline"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      Back to Run History
    </button>
  );
}
