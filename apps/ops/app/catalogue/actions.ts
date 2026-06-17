'use server';

// Server actions for the Catalogue (SKU editor) module (docs/010 §2). Same auth posture as the
// other modules: the SSR supabase client (anon key + the signed-in user's session), so RLS
// (is_allowed_user()) gates every read and write. The service-role key is never used here. All
// writes are direct, single-table, RLS-gated catalogue / barcodes writes — no RPC, no migration.

import { createSupabaseServerClient } from '@jigzle/db/server';
import type { CatalogueRow, CollisionRow } from '@jigzle/db/types';
import type { CatalogueListRow, SkuDetail } from './types';

const LIMIT = 50;

// PostgREST `.or()` / `.ilike()` interpolate the raw string into a filter grammar where , ( ) * \
// are operators. Strip them from operator-typed input (defense-in-depth; the operator is trusted).
function sanitize(q: string): string {
  return q.replace(/[,()*\\]/g, ' ').trim();
}

type CatNameRow = {
  item_code: string;
  brand_prefix: string | null;
  translate_name: string | null;
  original_name: string | null;
  self_code: string | null;
  needs_review: boolean | null;
};

function nameOf(c: CatNameRow): string {
  return c.translate_name || c.original_name || c.self_code || c.item_code;
}

const LIST_COLS = 'item_code,brand_prefix,translate_name,original_name,self_code,needs_review';

// ── All tab: search by item_code / name / barcode → list rows ──
export async function searchCatalogue(q: string): Promise<CatalogueListRow[]> {
  const raw = sanitize(q);
  if (raw.length < 2) return [];
  const supabase = createSupabaseServerClient();

  const [catRes, bcRes] = await Promise.all([
    supabase
      .from('catalogue')
      .select(LIST_COLS)
      .or(`item_code.ilike.%${raw}%,self_code.ilike.%${raw}%,original_name.ilike.%${raw}%,translate_name.ilike.%${raw}%`)
      .limit(LIMIT),
    supabase.from('barcodes').select('item_code').ilike('barcode', `%${raw}%`).limit(LIMIT),
  ]);

  const rows = new Map<string, CatalogueListRow>();
  for (const c of (catRes.data ?? []) as CatNameRow[]) {
    rows.set(c.item_code, { item_code: c.item_code, name: nameOf(c), brand_prefix: c.brand_prefix ?? null, needs_review: !!c.needs_review });
  }
  const bcCodes = [...new Set((bcRes.data ?? []).map((b) => b.item_code as string))].filter((code) => !rows.has(code));
  if (bcCodes.length) {
    const { data: cat2 } = await supabase.from('catalogue').select(LIST_COLS).in('item_code', bcCodes);
    for (const c of (cat2 ?? []) as CatNameRow[]) {
      rows.set(c.item_code, { item_code: c.item_code, name: nameOf(c), brand_prefix: c.brand_prefix ?? null, needs_review: !!c.needs_review });
    }
  }
  return [...rows.values()].slice(0, LIMIT);
}

// ── the edit pane: full SKU + its barcode links (with shared flags) ──
export async function getSku(itemCode: string): Promise<SkuDetail | null> {
  const supabase = createSupabaseServerClient();
  const code = itemCode?.trim();
  if (!code) return null;

  // full row — every catalogue column (the edit pane needs them all)
  const { data: sku } = await supabase.from('catalogue').select('*').eq('item_code', code).maybeSingle();
  if (!sku) return null;

  const { data: bcs } = await supabase.from('barcodes').select('barcode,is_verified').eq('item_code', code).order('barcode');
  const barcodes = (bcs ?? []) as { barcode: string; is_verified: boolean }[];

  // which of this SKU's barcodes are shared (linked to another SKU too)?
  const shared = new Set<string>();
  if (barcodes.length) {
    const codes = barcodes.map((b) => b.barcode);
    const { data: others } = await supabase.from('barcodes').select('barcode,item_code').in('barcode', codes);
    const owners = new Map<string, Set<string>>();
    for (const o of (others ?? []) as { barcode: string; item_code: string }[]) {
      (owners.get(o.barcode) ?? owners.set(o.barcode, new Set()).get(o.barcode)!).add(o.item_code);
    }
    for (const [bc, set] of owners) if (set.size > 1) shared.add(bc);
  }

  return {
    sku: sku as CatalogueRow,
    barcodes: barcodes.map((b) => ({ barcode: b.barcode, is_verified: b.is_verified, shared: shared.has(b.barcode) })),
  };
}

// ── save the changed catalogue fields (+ stamp updated_at). item_code is never editable ──
export async function updateSku(itemCode: string, patch: Partial<CatalogueRow>): Promise<void> {
  const supabase = createSupabaseServerClient();
  const code = itemCode?.trim();
  if (!code) throw new Error('updateSku: item_code is required');

  // identity / system columns are never written from the editor
  const { item_code: _ic, created_at: _ca, updated_at: _ua, ...rest } = patch as Record<string, unknown>;
  const upd: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) upd[k] = v;
  upd.updated_at = new Date().toISOString();

  const { error } = await supabase.from('catalogue').update(upd).eq('item_code', code);
  if (error) throw new Error(`updateSku: ${error.message}`);
}

// ── barcode manager: add a link (composite key — a code on another SKU just becomes shared) ──
export async function addBarcode(itemCode: string, barcode: string): Promise<void> {
  const supabase = createSupabaseServerClient();
  const code = itemCode?.trim();
  const bc = barcode?.trim();
  if (!code) throw new Error('addBarcode: item_code is required');
  if (!bc) throw new Error('addBarcode: a barcode is required');
  const { error } = await supabase.from('barcodes').insert({ barcode: bc, item_code: code, is_verified: false });
  // 23505 = this exact (barcode, item_code) link already exists → idempotent no-op
  if (error && error.code !== '23505') throw new Error(`addBarcode: ${error.message}`);
}

// ── unlink: remove only THIS SKU's link to the barcode (leaves other SKUs' links intact) ──
export async function unlinkBarcode(itemCode: string, barcode: string): Promise<void> {
  const supabase = createSupabaseServerClient();
  const code = itemCode?.trim();
  const bc = barcode?.trim();
  if (!code || !bc) throw new Error('unlinkBarcode: item_code and barcode are required');
  const { error } = await supabase.from('barcodes').delete().eq('barcode', bc).eq('item_code', code);
  if (error) throw new Error(`unlinkBarcode: ${error.message}`);
}

// ── toggle a barcode link's verified flag (this SKU's link only) ──
export async function setVerified(itemCode: string, barcode: string, v: boolean): Promise<void> {
  const supabase = createSupabaseServerClient();
  const code = itemCode?.trim();
  const bc = barcode?.trim();
  if (!code || !bc) throw new Error('setVerified: item_code and barcode are required');
  const { error } = await supabase.from('barcodes').update({ is_verified: v }).eq('barcode', bc).eq('item_code', code);
  if (error) throw new Error(`setVerified: ${error.message}`);
}

// ── needs-review queue: clear the flag (+ stamp updated_at) ──
export async function clearNeedsReview(itemCode: string): Promise<void> {
  const supabase = createSupabaseServerClient();
  const code = itemCode?.trim();
  if (!code) throw new Error('clearNeedsReview: item_code is required');
  const { error } = await supabase
    .from('catalogue')
    .update({ needs_review: false, updated_at: new Date().toISOString() })
    .eq('item_code', code);
  if (error) throw new Error(`clearNeedsReview: ${error.message}`);
}

// ── needs-review tab: the D2 stub queue ──
export async function getNeedsReview(): Promise<CatalogueListRow[]> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase.from('catalogue').select(LIST_COLS).eq('needs_review', true).order('item_code').limit(500);
  return ((data ?? []) as CatNameRow[]).map((c) => ({
    item_code: c.item_code,
    name: nameOf(c),
    brand_prefix: c.brand_prefix ?? null,
    needs_review: true,
  }));
}

// ── shared-barcodes tab: the barcode_collisions view (0020) ──
export async function getSharedBarcodes(): Promise<CollisionRow[]> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase.from('barcode_collisions').select('barcode,n,item_codes').order('barcode').limit(1000);
  return (data ?? []) as CollisionRow[];
}
