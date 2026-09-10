'use client';

// "← Back to Dashboard", shown on Run History when the user arrived there by
// clicking View all on the dashboard.
//
// Same contract as BackToRunHistory, one level up: it renders ONLY when the URL
// carries ?from=dashboard, so Run History keeps its normal appearance when
// reached through the sidebar — a permanent back link on a top-level page would
// be pointing somewhere the user did not come from. history.back() is used when
// this page really was pushed from the dashboard, which restores the previous
// scroll position; a plain push to / covers a shared or bookmarked link.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

export function BackToDashboard() {
  const router = useRouter();
  const [show, setShow] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);

  useEffect(() => {
    try {
      const sp = new URLSearchParams(window.location.search);
      setShow(sp.get('from') === 'dashboard');
      // history.length > 1 alone is not evidence the previous entry is ours.
      // The dashboard is the site root, so the referrer's PATH has to be
      // exactly "/" — includes('/') would match every page on the site.
      const ref = typeof document !== 'undefined' ? document.referrer : '';
      let fromRoot = false;
      try { fromRoot = !!ref && new URL(ref).pathname === '/'; } catch { /* not a URL */ }
      setCanGoBack(fromRoot);
    } catch { /* SSR / no window */ }
  }, []);

  if (!show) return null;

  return (
    <button
      onClick={() => { if (canGoBack) router.back(); else router.push('/'); }}
      className="inline-flex items-center gap-1.5 text-xs font-medium text-primary-700 hover:text-primary-800 hover:underline"
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      Back to Dashboard
    </button>
  );
}
