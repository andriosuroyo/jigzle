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

export async function resolveSkuImages(itemCodes: string[]): Promise<SkuImageMap> {
  const codes = [...new Set((itemCodes ?? []).filter(Boolean))];
  if (!codes.length) return {};
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('sku_image_resolved')
    .select('item_code,image_status,display_path')
    .in('item_code', codes);
  if (error || !data) return {}; // view missing (pre-0021) or transient error → no images, screens unaffected

  const map: SkuImageMap = {};
  for (const r of data as { item_code: string; image_status: ImageStatus; display_path: string | null }[]) {
    map[r.item_code] = { status: r.image_status, displayUrl: publicUrl(r.display_path) };
  }
  return map;
}

export async function resolveSkuImage(itemCode: string): Promise<SkuImageEntry | null> {
  const code = itemCode?.trim();
  if (!code) return null;
  const map = await resolveSkuImages([code]);
  return map[code] ?? null;
}
