'use client';

// Shared SKU thumbnail (docs/011 §5.1). One ~400px display.webp served small, everywhere. The
// browser fetches it straight from the Storage CDN (loading="lazy") — never through SQL/a server
// action. status undefined = unresolved (e.g. before 0021 / the importer) → render nothing, so the
// screens look exactly as today until images are populated.

import type { ImageStatus } from '@jigzle/db/types';

export default function SkuImage({
  status,
  displayUrl,
  name,
  size = 40,
}: {
  status?: ImageStatus;
  displayUrl?: string | null;
  name?: string;
  size?: number;
}) {
  if (!status) return null;
  const dim = { width: size, height: size, minWidth: size };

  if (status === 'has_image' && displayUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- intentional: static CDN image, off the data path
    return <img className="sku-img" src={displayUrl} alt={name || ''} loading="lazy" style={dim} />;
  }
  if (status === 'not_found') {
    return <span className="sku-img sku-img-none" style={dim} title="no image" aria-label="no image">🖼️</span>;
  }
  // pending (or has_image without a served file yet) → an actionable empty drop-target affordance
  return <span className="sku-img sku-img-pending" style={dim} title="image pending" aria-label="image pending" />;
}
