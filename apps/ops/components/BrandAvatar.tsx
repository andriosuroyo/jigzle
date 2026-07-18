'use client';

// PR378/PR379 — a brand's visual mark, shared by Catalog → Browse and Settings → Brand logos so the two
// always match. Renders the brand's logo image when a logo_url is set (and loads); otherwise a
// deterministic monogram (initials + a stable colour from the prefix). A broken/blocked image URL falls
// back to the monogram too, so a bad link never leaves an empty box.

import { useEffect, useState } from 'react';

const MONO_COLORS = ['#7B9E89', '#C08457', '#6B8CAE', '#B0687A', '#9A7BAE', '#B79A3E', '#5FA0A0', '#A8735A'];

export function brandInitials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return (w[0][0] + w[1][0]).toUpperCase();
}

export function brandColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return MONO_COLORS[h % MONO_COLORS.length];
}

export default function BrandAvatar({
  name,
  prefix,
  logoUrl,
  className = '',
}: {
  name: string;
  prefix: string;
  logoUrl?: string | null;
  className?: string;
}) {
  const [errored, setErrored] = useState(false);
  useEffect(() => { setErrored(false); }, [logoUrl]); // a new URL gets a fresh try

  if (logoUrl && !errored) {
    // eslint-disable-next-line @next/next/no-img-element -- external brand logo, off the data path
    return <img className={`cat-mono cat-mono-img ${className}`} src={logoUrl} alt={name} onError={() => setErrored(true)} />;
  }
  return (
    <span className={`cat-mono ${className}`} aria-hidden="true" style={{ background: brandColor(prefix) }}>
      {brandInitials(name)}
    </span>
  );
}
