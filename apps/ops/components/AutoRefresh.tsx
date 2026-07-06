'use client';

// PR195 (URGENT freshness fix): a global safety net that re-pulls fresh server data when the operator
// returns to the app — on tab re-focus / becoming visible again. Pairs with next.config's
// staleTimes:0 (which makes every NAVIGATION fresh): this covers the "left the tab, did something on
// another device / another window, came back" case without a manual refresh. router.refresh() refetches
// the current route's server components; it never resets typed input or in-progress client state, so
// it's safe to fire liberally. Throttled so rapid focus/visibility flapping can't cause a refetch storm.

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

const MIN_INTERVAL_MS = 2000; // don't refetch more than once per 2s of focus/visibility churn

export default function AutoRefresh() {
  const router = useRouter();
  const lastRef = useRef(0);

  useEffect(() => {
    const refresh = () => {
      const now = Date.now();
      if (now - lastRef.current < MIN_INTERVAL_MS) return;
      lastRef.current = now;
      router.refresh();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router]);

  return null;
}
