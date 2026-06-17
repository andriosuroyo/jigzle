'use client';

// Resolve a screen's visible SKUs' images in one batch read, keyed by the (deduped, sorted) set of
// item_codes so it refetches only when the set actually changes. Results merge into prior state so
// already-resolved SKUs stay cached (CDN-friendly, no flicker). Latest-wins so a slow response
// can't clobber a newer set. Failures are swallowed → the screen just shows no images.

import { useEffect, useMemo, useRef, useState } from 'react';
import { resolveSkuImages } from '@/app/images/actions';
import type { SkuImageMap } from '@/app/images/types';

// U+0001 — a control char that can never appear in an item_code, so a code containing a comma (or
// any printable char) can't be split apart when we round-trip the set through a string key.
const SEP = '\u0001';

export function useSkuImages(itemCodes: (string | null | undefined)[]): SkuImageMap {
  const key = useMemo(
    () => [...new Set((itemCodes ?? []).filter(Boolean) as string[])].sort().join(SEP),
    [itemCodes]
  );
  const [map, setMap] = useState<SkuImageMap>({});
  const reqRef = useRef(0);

  useEffect(() => {
    if (!key) return;
    const codes = key.split(SEP);
    const myReq = ++reqRef.current;
    resolveSkuImages(codes)
      .then((m) => {
        if (reqRef.current === myReq) setMap((prev) => ({ ...prev, ...m }));
      })
      .catch(() => {
        /* no images on error — screen unaffected */
      });
  }, [key]);

  return map;
}
