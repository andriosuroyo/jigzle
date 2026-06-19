'use server';

// Server actions for the Catalogue (SKU editor) module (docs/010 §2). Same auth posture as the
// other modules: the SSR supabase client (anon key + the signed-in user's session), so RLS
// (is_allowed_user()) gates every read and write. The service-role key is never used here. All
// writes are direct, single-table, RLS-gated catalogue / barcodes writes — no RPC, no migration.

import { createSupabaseServerClient } from '@jigzle/db/server';
import type { CatalogueRow, CollisionRow } from '@jigzle/db/types';
import { isComplete } from './types';
import type { BarcodeOwner, CatalogueListRow, QuickAddResult, SkuDetail } from './types';

const LIMIT = 200;

type Supabase = ReturnType<typeof createSupabaseServerClient>;

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

// brand_prefix for a quick-added SKU = the LONGEST known brand prefix the item_code starts with
// (so compound prefixes like DIS-TDL win over DIS); null when nothing matches. brand_prefix is a FK
// to brands(prefix), so a derived value MUST exist in brands or the insert would fail — hence the
// lookup rather than a blind string split.
async function deriveBrandPrefix(supabase: Supabase, itemCode: string): Promise<string | null> {
  const segs = itemCode.split('-').filter(Boolean);
  if (segs.length < 2) {
    const { data } = await supabase.from('brands').select('prefix').eq('prefix', itemCode).maybeSingle();
    return data ? itemCode : null;
  }
  const candidates: string[] = [];
  for (let i = segs.length - 1; i >= 1; i--) candidates.push(segs.slice(0, i).join('-')); // longest first
  const { data } = await supabase.from('brands').select('prefix').in('prefix', candidates);
  const found = new Set(((data ?? []) as { prefix: string }[]).map((b) => b.prefix));
  for (const cand of candidates) if (found.has(cand)) return cand;
  return null;
}

// ── All tab: search by item_code / name / barcode → list rows ──
export async function searchCatalogue(q: string): Promise<CatalogueListRow[]> {
  const raw = sanitize(q);
  if (raw.length < 2) return [];
  const supabase = createSupabaseServerClient();

  const tokens = raw.split(/\s+/).filter(Boolean);
  const pieceTerms   = tokens.filter((t) => /^\d{1,5}$/.test(t)).map(Number);
  const barcodeTerms = tokens.filter((t) => /^\d{6,}$/.test(t));
  const textTerms    = tokens.filter((t) => !/^\d+$/.test(t));

  let barcodeCodes: string[] | null = null;
  for (const b of barcodeTerms) {
    const { data } = await supabase.from('barcodes').select('item_code').ilike('barcode', `%${b}%`).limit(LIMIT);
    const codes = [...new Set((data ?? []).map((r) => r.item_code as string))];
    barcodeCodes = barcodeCodes === null ? codes : barcodeCodes.filter((c) => codes.includes(c));
  }
  if (barcodeCodes !== null && barcodeCodes.length === 0) return [];

  let query = supabase.from('catalogue').select(LIST_COLS);
  for (const t of textTerms) {
    query = query.or(`item_code.ilike.%${t}%,self_code.ilike.%${t}%,original_name.ilike.%${t}%,translate_name.ilike.%${t}%`);
  }
  for (const n of pieceTerms) query = query.eq('piece_count_n', n);
  if (barcodeCodes !== null) query = query.in('item_code', barcodeCodes);

  const { data } = await query.order('item_code').limit(LIMIT);
  return (data ?? []).map((c) => {
    const r = c as CatNameRow;
    return { item_code: r.item_code, name: nameOf(r), brand_prefix: r.brand_prefix ?? null, needs_review: !!r.needs_review };
  });
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
  const { item_code: _ic, created_at: _ca, updated_at: _ua, input_date: _id, ...rest } = patch as Record<string, unknown>;
  const upd: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) upd[k] = v;
  upd.updated_at = new Date().toISOString();

  // Completion gate (PR18 §6): needs_review is DERIVED on every save — recompute it from the final
  // row (current values overlaid with this patch), NOT cleared blindly. A SKU drops off Needs-review
  // only once complete: name + brand_prefix + product_type, plus piece_count_n if a puzzle.
  const { data: cur } = await supabase
    .from('catalogue')
    .select('brand_prefix,product_type,piece_count_n,original_name,translate_name')
    .eq('item_code', code)
    .maybeSingle();
  if (cur) {
    const curRow = cur as Record<string, unknown>;
    const pick = (k: string) => (k in upd ? upd[k] : curRow[k]);
    upd.needs_review = !isComplete({
      brand_prefix: (pick('brand_prefix') as string | null) ?? null,
      product_type: (pick('product_type') as string | null) ?? null,
      piece_count_n: (pick('piece_count_n') as number | null) ?? null,
      original_name: (pick('original_name') as string | null) ?? null,
      translate_name: (pick('translate_name') as string | null) ?? null,
    });
  }

  const { error } = await supabase.from('catalogue').update(upd).eq('item_code', code);
  if (error) throw new Error(`updateSku: ${error.message}`);
}

// ── quick-add (PR18 §6): create a PARTIAL SKU from a Stock Check session ──
// Minimal data now (name + product_type + optional barcode), needs_review=true so admin completes it
// later. Inserts the catalogue row (original_name=name, derived brand_prefix; input_date defaults to
// today via 0025) and links the optional barcode (shared model — a code already on another SKU just
// becomes a shared link). Adding the SKU to the open count is the caller's existing add-missing path.
export async function quickAddSku(input: {
  item_code: string;
  name: string;
  product_type: string;
  barcode?: string | null;
}): Promise<QuickAddResult> {
  const supabase = createSupabaseServerClient();
  const code = input.item_code?.trim();
  const name = input.name?.trim();
  const ptype = input.product_type?.trim();
  const bc = input.barcode?.trim() || null;
  if (!code) return { ok: false, reason: 'invalid', message: 'Item code is required.' };
  if (!name) return { ok: false, reason: 'invalid', message: 'Name is required.' };
  if (!ptype) return { ok: false, reason: 'invalid', message: 'Pick a product type.' };

  // uniqueness — item_code is the PK; if taken, offer the existing SKU instead of creating a dup.
  const { data: exist } = await supabase
    .from('catalogue')
    .select('item_code,brand_prefix,translate_name,original_name,self_code,needs_review')
    .eq('item_code', code)
    .maybeSingle();
  if (exist) return { ok: false, reason: 'exists', existing: { item_code: code, name: nameOf(exist as CatNameRow) } };

  const brand_prefix = await deriveBrandPrefix(supabase, code);

  const { error: insErr } = await supabase.from('catalogue').insert({
    item_code: code,
    original_name: name,
    product_type: ptype,
    brand_prefix,           // null when the code prefix isn't a known brand
    needs_review: true,     // PARTIAL — surfaced in /catalog Needs-review until completed
  });
  if (insErr) {
    if (insErr.code === '23505') {
      // raced insert between the check and here — offer the existing one rather than erroring.
      const { data: e2 } = await supabase
        .from('catalogue')
        .select('item_code,brand_prefix,translate_name,original_name,self_code,needs_review')
        .eq('item_code', code)
        .maybeSingle();
      return { ok: false, reason: 'exists', existing: { item_code: code, name: e2 ? nameOf(e2 as CatNameRow) : code } };
    }
    return { ok: false, reason: 'invalid', message: insErr.message };
  }

  // optional barcode link — best-effort. The composite (barcode,item_code) key means a code already
  // owned by another SKU just becomes shared (the caller showed the owners first); 23505 = this exact
  // link already exists. A link hiccup does NOT unwind the created SKU (manage it in /catalog).
  if (bc) await supabase.from('barcodes').insert({ barcode: bc, item_code: code, is_verified: false });

  return { ok: true, item_code: code };
}

// SKUs already carrying a barcode — the shared-barcode owner warning shown in quick-add before a
// staffer creates a new SKU on a code that already resolves (pick the existing one, or share it).
export async function getBarcodeOwners(barcode: string): Promise<BarcodeOwner[]> {
  const supabase = createSupabaseServerClient();
  const bc = barcode?.trim();
  if (!bc) return [];
  const { data } = await supabase.from('barcodes').select('item_code').eq('barcode', bc);
  const codes = [...new Set(((data ?? []) as { item_code: string }[]).map((r) => r.item_code))];
  if (!codes.length) return [];
  const { data: cat } = await supabase
    .from('catalogue')
    .select('item_code,brand_prefix,translate_name,original_name,self_code,needs_review')
    .in('item_code', codes);
  const byCode = new Map<string, CatNameRow>();
  for (const c of (cat ?? []) as CatNameRow[]) byCode.set(c.item_code, c);
  return codes.map((item_code) => {
    const c = byCode.get(item_code);
    return { item_code, name: c ? nameOf(c) : item_code };
  });
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
  // most-recently-entered first (PR18) — quick-added partials surface at the top of the queue.
  const { data } = await supabase
    .from('catalogue')
    .select(LIST_COLS)
    .eq('needs_review', true)
    .order('input_date', { ascending: false, nullsFirst: false })
    .order('item_code')
    .limit(500);
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
