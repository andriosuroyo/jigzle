'use client';

// Shared SKU thumbnail (docs/011 §5.1, tuned in docs/014 §1). One ~400px display.webp served small,
// everywhere, straight from the Storage CDN (loading="lazy") — never through SQL/a server action.
//   has_image  → real <img>; if the file 404s, onError falls back to the grey pending look so the
//                operator never sees a broken-image icon.
//   not_found  → solid grey + a faint muted marker ("no picture is coming").
//   pending    → solid light-grey fill, no icon ("slot waiting for its picture").
//   status undefined → render nothing (pre-0021 / pre-importer safety).

import { useEffect, useState } from 'react';
import type { ImageStatus } from '@jigzle/db/types';
import { SKU_IMG } from '@/components/skuImageSizes';

export default function SkuImage({
  status,
  displayUrl,
  name,
  size = SKU_IMG.sm,
}: {
  status?: ImageStatus;
  displayUrl?: string | null;
  name?: string;
  size?: number;
}) {
  const [errored, setErrored] = useState(false);
  // Reset when a different SKU resolves into this slot, so a prior 404 doesn't stick.
  useEffect(() => {
    setErrored(false);
  }, [displayUrl]);

  if (!status) return null;
  const dim = { width: size, height: size, minWidth: size };

  if (status === 'has_image' && displayUrl && !errored) {
    // eslint-disable-next-line @next/next/no-img-element -- intentional: static CDN image, off the data path
    return (
      <img
        className="sku-img"
        src={displayUrl}
        alt={name || ''}
        loading="lazy"
        style={dim}
        onError={() => setErrored(true)}
      />
    );
  }
  if (status === 'not_found') {
    return (
      <span className="sku-img sku-img-none" style={dim} title="no image" aria-label="no image">–</span>
    );
  }
  // pending (or has_image whose file isn't there yet / 404'd) → the grey "slot waiting" look
  return <span className="sku-img sku-img-pending" style={dim} title="image pending" aria-label="image pending" />;
}
