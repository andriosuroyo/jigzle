'use client';

// PR223 — persist a tab / sub-list selection in the URL query string so the breadcrumb Refresh button
// (a hard window.location.reload — the reliable way to pull fresh data + drop the PWA cache) lands the
// operator back on the SAME tab/list instead of the default. Drop-in replacement for a useState tab:
//   const [tab, setTab] = useUrlTab<Tab>('tab', 'search', TAB_KEYS);
//
//  • Seeds from `fallback`, so the server render and the first client render agree (no hydration mismatch).
//  • Adopts the value from the URL once, on mount — a refresh arrives with ?key=… already set.
//  • On every change, writes the exact value back via history.replaceState: no navigation, no server
//    round-trip, no scroll jump — the value is simply there when the page is next reloaded.
//
// When more than one tabbed component is mounted on the same route, give each a DISTINCT `key` so their
// params don't clash (e.g. Purchasing's `tab` vs its To-buy board's `buy`, Sales' `tab` vs Pending's `pf`).

import { useCallback, useEffect, useState } from 'react';

export function useUrlTab<T extends string>(key: string, fallback: T, valid: readonly T[]): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(fallback);

  // adopt the URL's value on mount (in an effect, not the useState initializer, to keep SSR === first
  // client render — the URL only differs from the fallback after a refresh landed on a non-default tab)
  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get(key);
    if (raw && (valid as readonly string[]).includes(raw)) setValue(raw as T);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = useCallback((v: T) => {
    setValue(v);
    const url = new URL(window.location.href);
    url.searchParams.set(key, v);
    window.history.replaceState(window.history.state, '', url.toString());
  }, [key]);

  return [value, set];
}
