'use client';

// Re-render a server component page on a timer.
//
// The dashboard is force-dynamic, so its resource cards are computed fresh on
// every request — but only when a request happens. Without this, a station that
// starts executing a testcase keeps showing "available" until someone reloads.
// router.refresh() re-runs the server render and swaps in the new markup
// without losing client state or scroll position.

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const ms = Math.max(5, seconds) * 1000;
    const t = setInterval(() => router.refresh(), ms);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
