'use server';

// Server actions for the Stock Check module (docs/016). Same auth posture as the other boards: the
// SSR supabase client (anon key + the signed-in user's session), so RLS (is_allowed_user()) gates
// every read and write; the atomic RPCs do the multi-row work. Edit/delete of an adjustment is a
// plain RLS-gated table write (no RPC). The service-role key is never used here (smoke harness only).

import { createSupabaseServerClient } from '@jigzle/db/server';
import type {
  AdjustmentFilter,
  AdjustmentRow,
  BrandOption,
  CloseReviewEntry,
  CloseSummary,
  LineRow,
  NewCountInput,
  ScanResolve,
  ScanSku,
  SessionRow,
  SkuHit,
} from './types';

const SESSION_LIMIT = 100;
const LEDGER_LIMIT = 500;

// PostgREST .or()/.ilike() interpret , ( ) * \ as filter operators — strip them from operator-typed
// input (defense-in-depth; the operator is trusted).
function sanitize(q: string): string {
  return q.replace(/[,()*\\]/g, ' ').trim();
}

type CatNameRow = {
  item_code: string;
  translate_name: string | null;
  original_name: string | null;
  self_code: string | null;
  brand_prefix?: string | null;
};
function nameOf(c: CatNameRow | undefined, fallback: string): string {
  if (!c) return fallback;
  return c.translate_name || c.original_name || c.self_code || fallback;
}

type Supabase = ReturnType<typeof createSupabaseServerClient>;

// PostgREST caps a single response at ~1000 rows AND a long .in() list bloats the URL — chunk
// code lookups so a session/ledger with many SKUs resolves names/physical fully (no silent cut).
const CODE_CHUNK = 500;
async function catByCodes(supabase: Supabase, codes: string[]): Promise<Map<string, CatNameRow>> {
  const map = new Map<string, CatNameRow>();
  for (let i = 0; i < codes.length; i += CODE_CHUNK) {
    const { data } = await supabase
      .from('catalogue')
      .select('item_code,translate_name,original_name,self_code,brand_prefix')
      .in('item_code', codes.slice(i, i + CODE_CHUNK));
    for (const c of (data ?? []) as CatNameRow[]) map.set(c.item_code, c);
  }
  return map;
}
async function physByCodes(supabase: Supabase, codes: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (let i = 0; i < codes.length; i += CODE_CHUNK) {
    const { data } = await supabase.from('stock_check').select('item_code,physical').in('item_code', codes.slice(i, i + CODE_CHUNK));
    for (const s of (data ?? []) as { item_code: string; physical: number }[]) map.set(s.item_code, s.physical);
  }
  return map;
}

// the day AFTER a 'YYYY-MM-DD' (UTC), for a half-open [from, nextDay(to)) date range on timestamptz.
function nextDay(d: string): string {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

// ── reads ──────────────────────────────────────────────────────────────────

// brands for the New-count scope picker (only named brands; ordered by name).
export async function getBrands(): Promise<BrandOption[]> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase
    .from('brands')
    .select('prefix,name')
    .not('name', 'is', null)
    .order('name', { ascending: true });
  return ((data ?? []) as { prefix: string; name: string | null }[]).map((b) => ({ prefix: b.prefix, name: b.name }));
}

// the session list (open + closed/snapshots), newest first. Counts come from the stock_check_summary
// view (aggregated server-side) so the list never pulls every line (PostgREST row cap).
export async function getSessions(): Promise<SessionRow[]> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase
    .from('stock_check_summary')
    .select('stock_check_id,mode,scope,scope_brands,status,counted_by,note,started_at,closed_at,created_by,line_count,confirmed_count,changed_count')
    .order('started_at', { ascending: false })
    .limit(SESSION_LIMIT);
  return ((data ?? []) as SessionRow[]).map((s) => ({
    ...s,
    line_count: Number(s.line_count) || 0,
    confirmed_count: Number(s.confirmed_count) || 0,
    changed_count: Number(s.changed_count) || 0,
  }));
}

// every line in a session (paged past the 1000-row cap), with resolved name/brand + the LIVE
// on-shelf physical. Full coverage matters: Presence close requires a decision for every un-ticked
// line, so a truncated read would make an all_active session impossible to close.
export async function getSessionLines(stockCheckId: number): Promise<LineRow[]> {
  const supabase = createSupabaseServerClient();
  const PAGE = 1000;
  const raw: Omit<LineRow, 'name' | 'brand_prefix' | 'physical'>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await supabase
      .from('stock_check_lines')
      .select('line_id,stock_check_id,item_code,confirmed,counted_qty,expected_physical,delta,review_action,added_missing')
      .eq('stock_check_id', stockCheckId)
      .order('line_id', { ascending: true })
      .range(from, from + PAGE - 1);
    const rows = (data ?? []) as Omit<LineRow, 'name' | 'brand_prefix' | 'physical'>[];
    raw.push(...rows);
    if (rows.length < PAGE) break;
  }
  if (!raw.length) return [];

  const codes = [...new Set(raw.map((l) => l.item_code))];
  const [catMap, physMap] = await Promise.all([catByCodes(supabase, codes), physByCodes(supabase, codes)]);
  return raw.map((l) => {
    const c = catMap.get(l.item_code);
    return { ...l, name: nameOf(c, l.item_code), brand_prefix: c?.brand_prefix ?? null, physical: physMap.get(l.item_code) ?? 0 };
  });
}

// the Adjustments ledger (filter by source/date/search), newest first.
export async function getAdjustments(filter?: AdjustmentFilter): Promise<AdjustmentRow[]> {
  const supabase = createSupabaseServerClient();
  let query = supabase
    .from('adjustments')
    .select('adjustment_id,item_code,delta,source,stock_check_id,note,created_by,created_at')
    .order('created_at', { ascending: false })
    .limit(LEDGER_LIMIT);
  if (filter?.source && filter.source !== 'all') query = query.eq('source', filter.source);
  if (filter?.from) query = query.gte('created_at', filter.from);
  if (filter?.to) query = query.lt('created_at', nextDay(filter.to)); // half-open: through end of `to`

  const { data } = await query;
  const rows = (data ?? []) as Omit<AdjustmentRow, 'name'>[];
  if (!rows.length) return [];

  const catMap = await catByCodes(supabase, [...new Set(rows.map((r) => r.item_code))]);
  let out: AdjustmentRow[] = rows.map((r) => ({ ...r, name: nameOf(catMap.get(r.item_code), r.item_code) }));
  const raw = filter?.search ? sanitize(filter.search).toLowerCase() : '';
  if (raw) out = out.filter((r) => r.item_code.toLowerCase().includes(raw) || r.name.toLowerCase().includes(raw));
  return out;
}

// ── scan resolution (Count) — barcode → SKU / collision / not-found (self-contained, 0020 model) ──
export async function resolveScan(code: string): Promise<ScanResolve> {
  const supabase = createSupabaseServerClient();
  const c = code.trim();
  if (!c) return { status: 'not_found', code: c };

  const { data } = await supabase.from('barcodes').select('item_code,is_verified').eq('barcode', c);
  const byCode = new Map<string, boolean>();
  for (const row of (data ?? []) as { item_code: string; is_verified: boolean }[]) {
    byCode.set(row.item_code, (byCode.get(row.item_code) ?? false) || row.is_verified);
  }
  const codes = [...byCode.keys()];
  if (!codes.length) return { status: 'not_found', code: c };

  const { data: cat } = await supabase
    .from('catalogue')
    .select('item_code,translate_name,original_name,self_code')
    .in('item_code', codes);
  const nameByCode = new Map<string, string>();
  for (const cc of (cat ?? []) as CatNameRow[]) nameByCode.set(cc.item_code, nameOf(cc, cc.item_code));

  const skus: ScanSku[] = codes.map((item_code) => ({
    item_code,
    name: nameByCode.get(item_code) ?? item_code,
    is_verified: byCode.get(item_code) ?? false,
  }));
  return skus.length === 1 ? { status: 'resolved', sku: skus[0] } : { status: 'collision', skus };
}

// manual SKU search (catalogue text + barcode), with live available, for add-missing.
export async function searchSkus(q: string): Promise<SkuHit[]> {
  const raw = sanitize(q);
  if (raw.length < 2) return [];
  const supabase = createSupabaseServerClient();

  const named = new Map<string, string>();
  const [catRes, bcRes] = await Promise.all([
    supabase
      .from('catalogue')
      .select('item_code,original_name,translate_name,self_code')
      .or(`item_code.ilike.%${raw}%,self_code.ilike.%${raw}%,original_name.ilike.%${raw}%,translate_name.ilike.%${raw}%`)
      .limit(15),
    supabase.from('barcodes').select('item_code').ilike('barcode', `%${raw}%`).limit(15),
  ]);
  for (const c of (catRes.data ?? []) as CatNameRow[]) named.set(c.item_code, nameOf(c, c.item_code));

  const bcCodes = [...new Set((bcRes.data ?? []).map((b) => b.item_code as string))].filter((code) => !named.has(code));
  if (bcCodes.length) {
    const { data: cat2 } = await supabase
      .from('catalogue')
      .select('item_code,original_name,translate_name,self_code')
      .in('item_code', bcCodes);
    for (const c of (cat2 ?? []) as CatNameRow[]) named.set(c.item_code, nameOf(c, c.item_code));
  }

  const codes = [...named.keys()].slice(0, 20);
  if (!codes.length) return [];
  const { data: stock } = await supabase.from('stock_check').select('item_code,available').in('item_code', codes);
  const avail = new Map<string, number>(((stock ?? []) as { item_code: string; available: number }[]).map((s) => [s.item_code, s.available]));
  return codes.map((item_code) => ({ item_code, name: named.get(item_code)!, available: avail.get(item_code) ?? 0 }));
}

// ── writes (RPCs) ────────────────────────────────────────────────────────────

export async function openStockCheck(input: NewCountInput): Promise<number> {
  const counted_by = input.counted_by?.trim();
  if (!counted_by) throw new Error('openStockCheck: enter who is counting');
  if (input.scope === 'brand' && !input.brands.length) throw new Error('openStockCheck: pick at least one brand');
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('open_stock_check', {
    p_mode: input.mode,
    p_scope: input.scope,
    p_brands: input.scope === 'brand' ? input.brands : null,
    p_counted_by: counted_by,
    p_note: input.note?.trim() || null,
  });
  if (error) throw new Error(`openStockCheck: ${error.message}`);
  return data as number;
}

export async function cancelStockCheck(stockCheckId: number): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('cancel_stock_check', { p_stock_check_id: stockCheckId });
  if (error) throw new Error(`cancelStockCheck: ${error.message}`);
}

export async function confirmPresent(lineId: number): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('confirm_present', { p_line_id: lineId });
  if (error) throw new Error(`confirmPresent: ${error.message}`);
}

export async function unconfirmPresent(lineId: number): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('unconfirm', { p_line_id: lineId });
  if (error) throw new Error(`unconfirmPresent: ${error.message}`);
}

export async function recordCount(
  stockCheckId: number,
  itemCode: string,
  op: 'set' | 'inc',
  qty: number
): Promise<number> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('record_count', {
    p_stock_check_id: stockCheckId,
    p_item_code: itemCode,
    p_op: op,
    p_qty: qty,
  });
  if (error) throw new Error(`recordCount: ${error.message}`);
  return data as number;
}

export async function addMissingSku(stockCheckId: number, itemCode: string, qty: number): Promise<number> {
  if (!(qty > 0)) throw new Error('addMissingSku: a positive qty is required');
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('add_missing_sku', {
    p_stock_check_id: stockCheckId,
    p_item_code: itemCode,
    p_qty: qty,
  });
  if (error) throw new Error(`addMissingSku: ${error.message}`);
  return data as number;
}

export async function closeStockCheck(stockCheckId: number, review: CloseReviewEntry[]): Promise<CloseSummary> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('close_stock_check', {
    p_stock_check_id: stockCheckId,
    p_review: review,
  });
  if (error) throw new Error(`closeStockCheck: ${error.message}`);
  return data as CloseSummary;
}

export async function createManualAdjustment(itemCode: string, delta: number, note: string): Promise<number> {
  const code = itemCode?.trim();
  if (!code) throw new Error('createManualAdjustment: pick a SKU');
  if (!Number.isInteger(delta) || delta === 0) throw new Error('createManualAdjustment: enter a non-zero whole number');
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('create_manual_adjustment', {
    p_item_code: code,
    p_delta: delta,
    p_note: note?.trim() || null,
  });
  if (error) throw new Error(`createManualAdjustment: ${error.message}`);
  return data as number;
}

// edit/delete an adjustment = direct RLS-gated table writes (override or undo any auto-written delta).
export async function updateAdjustment(adjustmentId: number, patch: { delta?: number; note?: string | null }): Promise<void> {
  const set: Record<string, unknown> = {};
  if (patch.delta !== undefined) {
    if (!Number.isInteger(patch.delta) || patch.delta === 0) {
      throw new Error('updateAdjustment: delta must be a non-zero whole number (delete to undo)');
    }
    set.delta = patch.delta;
  }
  if (patch.note !== undefined) set.note = patch.note?.trim() || null;
  if (!Object.keys(set).length) return;
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from('adjustments').update(set).eq('adjustment_id', adjustmentId);
  if (error) throw new Error(`updateAdjustment: ${error.message}`);
}

export async function deleteAdjustment(adjustmentId: number): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from('adjustments').delete().eq('adjustment_id', adjustmentId);
  if (error) throw new Error(`deleteAdjustment: ${error.message}`);
}
