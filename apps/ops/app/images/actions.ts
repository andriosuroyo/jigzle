'use server';

// SKU-image read path (docs/011 §5.1 + §9). The screen resolves its visible item_codes in ONE
// batch read of sku_image_resolved (path only — never image bytes; no N+1, no per-image call); the
// browser then fetches each image straight from the Storage CDN, so images can't slow a query.
// Tolerant by design: if the view doesn't exist yet (0021 not applied) or the read errors, returns
// an empty map and the screens render exactly as before.

import { createSupabaseServerClient } from '@jigzle/db/server';
import type { ImageStatus } from '@jigzle/db/types';
import type { SkuImageEntry, SkuImageMap } from './types';

const BUCKET = 'sku-images';

// Build the public CDN URL from the bucket path. The bucket is public-read, so this is a plain,
// cacheable URL — no signing, no DB call.
function publicUrl(displayPath: string | null): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!displayPath || !base) return null;
  return `${base}/storage/v1/object/public/${BUCKET}/${displayPath}`;
}

// PR363 — turn a Google-Drive share link into a direct-render image URL (mirror of the client-side
// driveDirect in CatalogBoard). Handles /file/d/ID/…, ?id=ID, /thumbnail?id=ID, /uc?…id=ID; falls back
// to the raw string when no Drive file id is found. The file must be shared "anyone with the link".
function driveDirect(url: string): string {
  const u = (url || '').trim();
  if (!u) return '';
  const id = u.match(/\/d\/([-\w]{10,})/)?.[1] ?? u.match(/[?&]id=([-\w]{10,})/)?.[1];
  return id ? `https://drive.google.com/thumbnail?id=${id}&sz=w1000` : u;
}

// PR383 — chunk `.in(item_code, …)` lookups. A screen can now ask for an unbounded number of codes
// (Catalog → Browse no longer caps its SKU list), and a single .in() with thousands of ids would blow
// the PostgREST URL length; 200 per request stays well under it.
const IN_CHUNK = 200;
function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function resolveSkuImages(itemCodes: string[]): Promise<SkuImageMap> {
  const codes = [...new Set((itemCodes ?? []).filter(Boolean))];
  if (!codes.length) return {};
  const supabase = createSupabaseServerClient();

  const map: SkuImageMap = {};
  for (const part of chunk(codes, IN_CHUNK)) {
    const { data, error } = await supabase
      .from('sku_image_resolved')
      .select('item_code,image_status,display_path')
      .in('item_code', part);
    if (error) return map; // view missing (pre-0021) or transient error → return what we have so far
    for (const r of (data ?? []) as { item_code: string; image_status: ImageStatus; display_path: string | null }[]) {
      map[r.item_code] = { status: r.image_status, displayUrl: publicUrl(r.display_path) };
    }
  }

  // PR363 — fall back to the manually-entered Google-Drive image_urls for any SKU without a resolved
  // bucket image, so a picture added in the Catalog editor's Links tab shows up EVERYWHERE (lists,
  // Sales, Inbound, …) after saving — not just on the editor hero. The bucket image (canonical, when
  // present) always wins; this only fills the gap. Best-effort: a missing/failed read leaves the
  // pipeline result untouched, so screens are never worse off than before.
  const needFallback = codes.filter((c) => (map[c]?.status ?? 'pending') !== 'has_image' || !map[c]?.displayUrl);
  for (const part of chunk(needFallback, IN_CHUNK)) {
    const { data: manual } = await supabase
      .from('catalogue')
      .select('item_code,image_urls')
      .in('item_code', part);
    for (const r of (manual ?? []) as { item_code: string; image_urls: string[] | null }[]) {
      const first = (r.image_urls ?? []).map((u) => (u ?? '').trim()).find(Boolean);
      const url = first ? driveDirect(first) : '';
      if (url) map[r.item_code] = { status: 'has_image', displayUrl: url };
    }
  }

  return map;
}

export async function resolveSkuImage(itemCode: string): Promise<SkuImageEntry | null> {
  const code = itemCode?.trim();
  if (!code) return null;
  const map = await resolveSkuImages([code]);
  return map[code] ?? null;
}
