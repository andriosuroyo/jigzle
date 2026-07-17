'use server';

// Server actions for the Catalogue (SKU editor) module (docs/010 §2). Same auth posture as the
// other modules: the SSR supabase client (anon key + the signed-in user's session), so RLS
// (is_allowed_user()) gates every read and write. The service-role key is never used here. All
// writes are direct, single-table, RLS-gated catalogue / barcodes writes — no RPC, no migration.

import { createSupabaseServerClient } from '@jigzle/db/server';
import type { CatalogueRow, CollisionRow } from '@jigzle/db/types';
import { isComplete } from './types';
import type { BarcodeOwner, BrowseBrand, BrowseSku, CatalogueListRow, QuickAddResult, SkuDetail } from './types';

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

// ── All tab: search by SKU code / brand (name or prefix) / item name / piece count / barcode → list
// rows. PR346: routed through the search_catalogue RPC so it gains the SAME natural matching as the
// Sales SKU search — fuzzy typos (#1) and character/series aliases (#3) on top of the existing
// all-tokens-AND, word order, brand name/prefix, original name (#5) and barcode/piece-count. Falls back
// to the PostgREST query-builder below until 0090 is applied (graceful degrade), so search never breaks. ──
type RpcCatRow = { item_code: string; name: string; brand_prefix: string | null; needs_review: boolean | null };

export async function searchCatalogue(q: string): Promise<CatalogueListRow[]> {
  const raw = sanitize(q);
  if (raw.length < 2) return [];
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('search_catalogue', { p_q: raw });
  if (!error) {
    return ((data ?? []) as RpcCatRow[]).map((r) => ({
      item_code: r.item_code, name: r.name, brand_prefix: r.brand_prefix ?? null, needs_review: !!r.needs_review,
    }));
  }
  return searchCatalogueFallback(supabase, raw); // RPC not applied yet → degrade to the query-builder
}

// Pre-0090 fallback: the original PostgREST query-builder (no fuzzy / alias). A numeric 1–5 digit token
// is a piece count; 6+ digits a barcode; everything else a text term matched against item/self code,
// both names, AND any brand whose NAME contains the term. Multiple tokens AND together.
async function searchCatalogueFallback(supabase: Supabase, raw: string): Promise<CatalogueListRow[]> {
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
    const ors = [
      `item_code.ilike.%${t}%`,
      `self_code.ilike.%${t}%`,
      `original_name.ilike.%${t}%`,
      `translate_name.ilike.%${t}%`,
    ];
    // brands whose NAME matches this term → include their SKUs by prefix (prefixes are alnum/dashes,
    // safe to inline in the in-list). Lets a brand-name query like "Tenyo" or "Epoch" resolve.
    const { data: br } = await supabase.from('brands').select('prefix').ilike('name', `%${t}%`).limit(500);
    const prefixes = [...new Set(((br ?? []) as { prefix: string }[]).map((b) => b.prefix))];
    if (prefixes.length) ors.push(`brand_prefix.in.(${prefixes.join(',')})`);
    query = query.or(ors.join(','));
  }
  for (const n of pieceTerms) query = query.eq('piece_count_n', n);
  if (barcodeCodes !== null) query = query.in('item_code', barcodeCodes);

  const { data } = await query.order('item_code').limit(LIMIT);
  return (data ?? []).map((c) => {
    const r = c as CatNameRow;
    return { item_code: r.item_code, name: nameOf(r), brand_prefix: r.brand_prefix ?? null, needs_review: !!r.needs_review };
  });
}

// ── Browse tab (PR184): the whole catalogue as a lightweight projection, loaded ONCE, so the client
// can facet across ANY geographic scope (a whole region/country, not just one brand) and drill by
// theme — all client-side and instant after the load. No GROUP BY over PostgREST and (per this
// module's convention) no RPC/migration, so it's a bounded-concurrency paged scan (stable order so
// the page ranges partition cleanly). Returns the facet columns for every SKU + the brand list
// (prefix → name/country) the client folds into Region → Country → Brand. ──
export async function getCatalogFacetData(): Promise<{ skus: BrowseSku[]; brands: BrowseBrand[] }> {
  const supabase = createSupabaseServerClient();

  const { data: br } = await supabase.from('brands').select('prefix,name,country').order('name');
  const brands = ((br ?? []) as { prefix: string; name: string | null; country: string | null }[]).map(
    (b) => ({ prefix: b.prefix, name: b.name || b.prefix, country: b.country, count: 0 }),
  );

  const { count } = await supabase.from('catalogue').select('item_code', { count: 'exact', head: true });
  const total = count ?? 0;
  const PAGE = 1000;
  const pages = Math.ceil(total / PAGE);
  const CONC = 8; // fire page ranges in bounded-concurrency batches (avoid a wide fan-out)
  const COLS =
    'item_code,brand_prefix,translate_name,original_name,self_code,needs_review,product_type,piece_count_n,material,effect,theme,artist';
  const skus: BrowseSku[] = [];
  for (let start = 0; start < pages; start += CONC) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(CONC, pages - start) }, (_, k) => {
        const from = (start + k) * PAGE;
        return supabase.from('catalogue').select(COLS).order('item_code').range(from, from + PAGE - 1);
      }),
    );
    for (const { data } of batch)
      for (const r of (data ?? []) as (CatNameRow & {
        product_type: string | null; piece_count_n: number | null; material: string | null;
        effect: string | null; theme: string | null; artist: string | null;
      })[])
        skus.push({
          item_code: r.item_code, name: nameOf(r), brand_prefix: r.brand_prefix ?? null, needs_review: !!r.needs_review,
          product_type: r.product_type ?? null, piece_count_n: r.piece_count_n ?? null, material: r.material ?? null,
          effect: r.effect ?? null, theme: r.theme ?? null, artist: r.artist ?? null,
        });
  }

  return { skus, brands };
}

// ── PR188: distinct existing values per field, for the item editor's dropdowns (datalists). One paged
// scan of the relevant columns (no GROUP BY over PostgREST); the response is just the sorted distinct
// value lists (small). The client caches it for the session. ──
const OPTION_FIELDS = ['product_type', 'sub_type', 'piece_type', 'piece_size', 'material', 'effect', 'image_type', 'theme', 'location', 'artist'] as const;
export async function getCatalogFieldOptions(): Promise<Record<string, string[]>> {
  const supabase = createSupabaseServerClient();
  const { count } = await supabase.from('catalogue').select('item_code', { count: 'exact', head: true });
  const total = count ?? 0;
  const PAGE = 1000;
  const pages = Math.ceil(total / PAGE);
  const CONC = 8;
  const sets: Record<string, Set<string>> = {};
  for (const f of OPTION_FIELDS) sets[f] = new Set();
  for (let start = 0; start < pages; start += CONC) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(CONC, pages - start) }, (_, k) => {
        const from = (start + k) * PAGE;
        return supabase.from('catalogue').select(OPTION_FIELDS.join(',')).order('item_code').range(from, from + PAGE - 1);
      }),
    );
    for (const { data } of batch)
      for (const r of (data ?? []) as unknown as Record<string, unknown>[])
        for (const f of OPTION_FIELDS) { const v = r[f]; if (typeof v === 'string' && v.trim()) sets[f].add(v.trim()); }
  }

  // PR193 — union the Settings-managed classification lists (0059) so curated values always appear
  // even if no SKU uses them yet, and typo-variants retired in Settings simply drop out of the SKU's
  // distinct values over time. Degrades silently if the tables aren't applied yet.
  const MANAGED: Record<string, string> = {
    product_type: 'settings_catalog_product_types',
    sub_type: 'settings_catalog_sub_types',
    piece_type: 'settings_catalog_piece_types',
  };
  await Promise.all(
    Object.entries(MANAGED).map(async ([field, table]) => {
      const { data } = await supabase.from(table).select('label').is('user_id', null).eq('is_active', true);
      for (const r of (data ?? []) as { label: string | null }[]) { const v = (r.label ?? '').trim(); if (v) sets[field].add(v); }
    }),
  );

  const out: Record<string, string[]> = {};
  for (const f of OPTION_FIELDS) out[f] = [...sets[f]].sort((a, b) => a.localeCompare(b));
  return out;
}

// ── PR368: managed Sub types with their linked Product type (0097). The editor's Sub type picker
// offers only sub-types that HAVE a product type, filtered to the SKU's selected product type. Degrades
// to [] if the column/table isn't there yet (pre-0097) — the picker then falls back to distinct values. ──
export async function getCatalogSubTypes(): Promise<{ label: string; product_type: string }[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('settings_catalog_sub_types')
    .select('label,product_type')
    .is('user_id', null)
    .eq('is_active', true)
    .not('product_type', 'is', null);
  if (error) return [];
  return ((data ?? []) as { label: string | null; product_type: string | null }[])
    .filter((r): r is { label: string; product_type: string } => !!r.label && !!r.product_type);
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

  // Completion gate (PR18 §6): needs_review is DERIVED on every save — recompute it from the final
  // row (current values overlaid with this patch), NOT cleared blindly. A SKU drops off Needs-review
  // only once complete: name + brand_prefix + product_type, plus piece_count_n if a puzzle.
  const { data: cur } = await supabase
    .from('catalogue')
    .select('brand_prefix,product_type,piece_count_n,original_name,translate_name,piece_size,material')
    .eq('item_code', code)
    .maybeSingle();
  let est: number | null = null;
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
    // PR211: keep the weight estimate fresh from the final piece count / size band / material.
    est = estimateWeight((pick('piece_count_n') as number | null) ?? null, (pick('piece_size') as string | null) ?? null, (pick('material') as string | null) ?? null);
  }

  const { error } = await supabase.from('catalogue').update(upd).eq('item_code', code);
  if (error) throw new Error(`updateSku: ${error.message}`);

  // Best-effort est_weight refresh — a separate write so a missing column (pre-0070) can't fail the save.
  await supabase.from('catalogue').update({ est_weight: est }).eq('item_code', code);
}

// ── PR364: rename a SKU's item_code across the whole system (fix a mis-typed / mis-cased code) ──
// Delegates to the rename_sku() DB function (0096), which re-keys the catalogue row (every FK child
// cascades) + the non-FK item_code_raw copies in ONE atomic transaction. Error-as-data (awaited by a
// button handler — never throw). Degrades with a clear message until the migration is applied.
export async function renameSku(oldCode: string, newCode: string): Promise<{ error: string | null }> {
  const supabase = createSupabaseServerClient();
  const oc = oldCode?.trim();
  const nc = newCode?.trim();
  if (!oc || !nc) return { error: 'Both the current and new SKU codes are required.' };
  if (oc === nc) return { error: null };

  // friendly pre-check (the function guards atomically too — this just gives a nicer message).
  const { data: clash } = await supabase.from('catalogue').select('item_code').eq('item_code', nc).maybeSingle();
  if (clash) return { error: `“${nc}” already exists — pick a code that isn't already in use.` };
  const { data: src } = await supabase.from('catalogue').select('item_code').eq('item_code', oc).maybeSingle();
  if (!src) return { error: `“${oc}” was not found.` };

  const { error } = await supabase.rpc('rename_sku', { p_old: oc, p_new: nc });
  if (error) {
    // 42883 = function does not exist → migration 0096 not applied yet (graceful degrade)
    if (error.code === '42883' || /rename_sku.*does not exist|could not find the function/i.test(error.message)) {
      return { error: 'SKU rename isn’t enabled yet — database migration 0096 still needs to be applied in Supabase.' };
    }
    return { error: error.message };
  }
  return { error: null };
}

// ── quick-add (PR18 §6): create a PARTIAL SKU from a Stock Check session ──
// Minimal data now (name + product_type + optional barcode), needs_review=true so admin completes it
// later. Inserts the catalogue row (original_name=name, derived brand_prefix) and links the optional
// barcode (shared model — a code already on another SKU just becomes a shared link). Adding the SKU to
// the open count is the caller's existing add-missing path.
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

  // optional barcode link. The composite (barcode,item_code) key means a code already owned by another
  // SKU just becomes shared (the caller showed the owners first); 23505 = this exact link already
  // exists → idempotent. The SKU was just created, so a non-23505 failure (RLS / transient) means the
  // code did NOT attach — surface it as a SOFT warning, not a silent success (the SKU still exists;
  // the operator links the barcode later in /catalog). A link hiccup never unwinds the created SKU.
  let barcodeWarning: string | undefined;
  if (bc) {
    const { error: bcErr } = await supabase.from('barcodes').insert({ barcode: bc, item_code: code, is_verified: false });
    if (bcErr && bcErr.code !== '23505') barcodeWarning = `barcode not linked (${bcErr.message}) — add it in Catalog`;
  }

  return { ok: true, item_code: code, barcodeWarning };
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
  // created_at (a real existing column) is the insert time; legacy rows cluster at import, so the
  // newest quick-add / receive stubs sort to the top.
  const { data } = await supabase
    .from('catalogue')
    .select(LIST_COLS)
    .eq('needs_review', true)
    .order('created_at', { ascending: false })
    .order('item_code')
    .limit(500);
  return ((data ?? []) as CatNameRow[]).map((c) => ({
    item_code: c.item_code,
    name: nameOf(c),
    brand_prefix: c.brand_prefix ?? null,
    needs_review: true,
  }));
}

// ── PR208: Catalog Fix data-quality lists. Each returns up to FIX_CAP rows (the UI shows the count,
// with a "+" when capped). Lazy-loaded on the first Fix-tab open so /catalog stays fast. ──
const FIX_CAP = 300;
const toListRow = (c: CatNameRow): CatalogueListRow => ({ item_code: c.item_code, name: nameOf(c), brand_prefix: c.brand_prefix ?? null, needs_review: !!c.needs_review });

// ── PR211: weight estimate. Cardboard base 240 + 0.8·pieces·size_mult·material_mult (grams). Stored
// in catalogue.est_weight (0070), recomputed on every save, offered as a one-click fill in Fix. ──
function sizeMult(band: string | null): number {
  switch ((band || '').trim().toLowerCase()) {
    case 'micro': return 0.7;
    case 'tiny': return 0.8;
    case 'small': return 0.9;
    case 'large': return 1.2;
    case 'jumbo': return 1.5;
    default: return 1.0; // standard / unknown
  }
}
function materialMult(m: string | null): number {
  const s = (m || '').toLowerCase();
  if (s.includes('wood')) return 1.5;
  if (s.includes('plastic') || s.includes('crystal')) return 0.8;
  if (s.includes('cork')) return 0.6;
  if (s.includes('foam')) return 0.4;
  return 1.0; // cardboard / paper / blank
}
function estimateWeight(pieces: number | null, band: string | null, material: string | null): number | null {
  if (!pieces || pieces <= 0) return null;
  return Math.round(240 + 0.8 * pieces * sizeMult(band) * materialMult(material));
}

// SKUs with no real weight but an estimate available (has a piece count). Degrades to [] until 0070.
export type MissingWeightRow = CatalogueListRow & { est_weight: number; pieces: number | null };
export async function getMissingWeight(): Promise<MissingWeightRow[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('catalogue')
    .select(`${LIST_COLS},piece_count_n,est_weight`)
    .is('real_weight', null)
    .not('est_weight', 'is', null)
    .order('item_code')
    .limit(FIX_CAP);
  if (error) return []; // est_weight column missing (pre-0070) → degrade
  return ((data ?? []) as (CatNameRow & { piece_count_n: number | null; est_weight: number })[])
    .map((c) => ({ ...toListRow(c), est_weight: c.est_weight, pieces: c.piece_count_n }));
}

// Accept the estimate into real_weight (the Fix "accept" button). Returns error-as-data.
export async function acceptEstimatedWeight(itemCode: string): Promise<{ error: string | null; weight?: number }> {
  const supabase = createSupabaseServerClient();
  const code = itemCode.trim();
  const { data } = await supabase.from('catalogue').select('est_weight').eq('item_code', code).maybeSingle();
  const est = (data as { est_weight: number | null } | null)?.est_weight ?? null;
  if (est == null) return { error: 'No estimate available for this SKU.' };
  const { error } = await supabase.from('catalogue').update({ real_weight: est, updated_at: new Date().toISOString() }).eq('item_code', code);
  return { error: error ? error.message : null, weight: est };
}

// Untranslated: an original (usually Chinese/Japanese) name is present but the translated name is blank.
export async function getUntranslated(): Promise<CatalogueListRow[]> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase
    .from('catalogue')
    .select(LIST_COLS)
    .not('original_name', 'is', null)
    .is('translate_name', null)
    .order('item_code')
    .limit(FIX_CAP);
  return ((data ?? []) as CatNameRow[]).map(toListRow);
}

// Puzzle without a piece count — a jigsaw with piece_count_n blank (the completion gate needs it).
export async function getPuzzleNoPieces(): Promise<CatalogueListRow[]> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase
    .from('catalogue')
    .select(LIST_COLS)
    .ilike('product_type', '%puzzle%')
    .is('piece_count_n', null)
    .order('item_code')
    .limit(FIX_CAP);
  return ((data ?? []) as CatNameRow[]).map(toListRow);
}

// Implausible dimensions / weight — negative, zero-where-set, or absurdly large values (fat-fingers):
// any product/box dimension > 250 cm or < 0, a real weight < 0 or > 30 kg, or a piece count > 100k.
export async function getImplausibleDims(): Promise<CatalogueListRow[]> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase
    .from('catalogue')
    .select(LIST_COLS)
    .or([
      'real_weight.lt.0', 'real_weight.gt.30000',
      'size_p.gt.250', 'size_l.gt.250', 'size_t.gt.250', 'size_p.lt.0', 'size_l.lt.0', 'size_t.lt.0',
      'dim_p.gt.250', 'dim_l.gt.250', 'dim_t.gt.250', 'dim_p.lt.0', 'dim_l.lt.0', 'dim_t.lt.0',
      'piece_count_n.gt.100000', 'piece_count_n.lt.0',
    ].join(','))
    .order('item_code')
    .limit(FIX_CAP);
  return ((data ?? []) as CatNameRow[]).map(toListRow);
}

// Off-list classification — a product/sub/piece type value that isn't in the Settings pick-list
// (a typo, or a value that should be added to the list). Only these three fields have a canonical
// Settings list; theme/artist/material are free-text and can't be judged this way.
export type OffListRow = CatalogueListRow & { field: 'product_type' | 'sub_type' | 'piece_type'; value: string };
export async function getOffListClassification(): Promise<OffListRow[]> {
  const supabase = createSupabaseServerClient();
  const labels = async (table: string): Promise<Set<string>> => {
    const { data } = await supabase.from(table).select('label');
    return new Set(((data ?? []) as { label: string }[]).map((r) => r.label));
  };
  const [pt, st, pct] = await Promise.all([
    labels('settings_catalog_product_types'),
    labels('settings_catalog_sub_types'),
    labels('settings_catalog_piece_types'),
  ]);
  const out: OffListRow[] = [];
  const scan = async (col: OffListRow['field'], allowed: Set<string>) => {
    if (allowed.size === 0 || out.length >= FIX_CAP) return; // no pick-list → can't judge
    const inList = `(${[...allowed].map((v) => `"${v.replace(/"/g, '')}"`).join(',')})`;
    const { data } = await supabase
      .from('catalogue')
      .select(`${LIST_COLS},${col}`)
      .not(col, 'is', null)
      .not(col, 'in', inList)
      .order('item_code')
      .limit(FIX_CAP);
    for (const c of (data ?? []) as (CatNameRow & Record<string, string | null>)[]) {
      out.push({ ...toListRow(c), field: col, value: String(c[col] ?? '') });
    }
  };
  await scan('product_type', pt);
  await scan('sub_type', st);
  await scan('piece_type', pct);
  return out.slice(0, FIX_CAP);
}

// PR371 — Sub type ↔ Product type mismatch. A SKU whose (product_type, sub_type) PAIR isn't in the
// managed Settings list (0097). The existing off-list check judges each field alone, so a valid sub-type
// filed under the wrong product type slips through — this catches exactly that (and future drift). Paged
// scan of rows that have a sub_type. Degrades to [] until 0097 is applied (no managed pairs to judge).
export type SubMismatchRow = CatalogueListRow & { product_type: string; sub_type: string };
export async function getSubTypeMismatch(): Promise<SubMismatchRow[]> {
  const supabase = createSupabaseServerClient();
  const { data: mgr, error: mErr } = await supabase
    .from('settings_catalog_sub_types')
    .select('label,product_type')
    .is('user_id', null)
    .eq('is_active', true)
    .not('product_type', 'is', null);
  if (mErr) return [];
  const ok = new Set<string>();
  for (const r of (mgr ?? []) as { label: string | null; product_type: string | null }[]) {
    if (r.label && r.product_type) ok.add(`${r.product_type.trim()}${r.label.trim()}`);
  }
  if (!ok.size) return [];

  const out: SubMismatchRow[] = [];
  const PAGE = 1000;
  for (let from = 0; out.length < FIX_CAP; from += PAGE) {
    const { data, error } = await supabase
      .from('catalogue')
      .select(`${LIST_COLS},product_type,sub_type`)
      .not('sub_type', 'is', null)
      .neq('sub_type', '')
      .order('item_code')
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const c of data as (CatNameRow & { product_type: string | null; sub_type: string | null })[]) {
      const pt = (c.product_type ?? '').trim();
      const st = (c.sub_type ?? '').trim();
      if (st && !ok.has(`${pt}${st}`)) {
        out.push({ item_code: c.item_code, name: nameOf(c), brand_prefix: c.brand_prefix ?? null, needs_review: !!c.needs_review, product_type: pt || '—', sub_type: st });
        if (out.length >= FIX_CAP) break;
      }
    }
    if (data.length < PAGE) break;
  }
  return out;
}

// Missing image — a SKU with no resolvable bucket image (sku_image_resolved status ≠ has_image) that
// isn't flagged "no picture available". Only ~4k SKUs lack an image, so this is a workable list. Runs
// on its own (a moderate scan). Degrades to [] until 0071 (image_unavailable) is applied.
export async function getMissingImage(): Promise<CatalogueListRow[]> {
  const supabase = createSupabaseServerClient();
  const noImg: string[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('sku_image_resolved').select('item_code,image_status').neq('image_status', 'has_image').order('item_code').range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data as { item_code: string }[]) noImg.push(r.item_code);
    if (data.length < PAGE || noImg.length >= 8000) break;
  }
  if (!noImg.length) return [];
  const out: CatalogueListRow[] = [];
  for (let i = 0; i < noImg.length && out.length < FIX_CAP; i += 300) {
    const { data, error } = await supabase.from('catalogue').select(LIST_COLS).in('item_code', noImg.slice(i, i + 300)).eq('image_unavailable', false).limit(FIX_CAP);
    if (error) return []; // image_unavailable column missing (pre-0071) → degrade
    for (const c of (data ?? []) as CatNameRow[]) { out.push(toListRow(c)); if (out.length >= FIX_CAP) break; }
  }
  return out.slice(0, FIX_CAP);
}

// Likely duplicate SKUs — different item_codes that share the same normalized name + brand + piece
// count (an accidental double-entry of the same product). Scans the whole catalogue (paged), so it is
// loaded on its own (not blocking the fast Fix lists). Returns up to 200 groups, most-duplicated first.
export type DupGroup = { key: string; name: string; brand: string | null; pieces: number | null; members: { item_code: string; name: string }[] };
export async function getCatalogDuplicates(): Promise<DupGroup[]> {
  const supabase = createSupabaseServerClient();
  const PAGE = 1000;
  type Row = CatNameRow & { piece_count_n: number | null };
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('catalogue').select(`${LIST_COLS},piece_count_n`).order('item_code').range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < PAGE || rows.length >= 60000) break; // safety cap
  }
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const nm = nameOf(r);
    if (!nm || nm === r.item_code) continue; // no usable name → can't judge a duplicate
    const key = `${norm(nm)}|${(r.brand_prefix || '').toLowerCase()}|${r.piece_count_n ?? ''}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const out: DupGroup[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    out.push({ key: '', name: nameOf(members[0]), brand: members[0].brand_prefix, pieces: members[0].piece_count_n, members: members.map((m) => ({ item_code: m.item_code, name: nameOf(m) })) });
  }
  out.sort((a, b) => b.members.length - a.members.length);
  return out.slice(0, 200);
}

// ── PR217: source links (sku_sources, 0003) — the Links → Sources editor + the Purchasing "Buy"
// overlay both use these (getSkuSources also lives in purchasing/actions for that overlay). Up to 8
// slots (0071: source_index 0..7). setSkuSources replaces the whole set for a SKU. ──
export async function getSkuSources(itemCode: string): Promise<string[]> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase.from('sku_sources').select('url,source_index').eq('item_code', itemCode).order('source_index', { ascending: true });
  return (data ?? []).map((r) => (r as { url: string }).url).filter(Boolean);
}

export async function setSkuSources(itemCode: string, urls: string[]): Promise<{ error: string | null }> {
  const supabase = createSupabaseServerClient();
  const code = itemCode.trim();
  if (!code) return { error: 'setSkuSources: item_code is required' };
  const clean = urls.map((u) => u.trim()).filter(Boolean).slice(0, 8);

  // Snapshot the current rows so a failed insert (e.g. an 8th slot before 0072 is applied) can be
  // rolled back — the delete+insert isn't a transaction, so we restore on error to never lose data.
  const { data: prev } = await supabase.from('sku_sources').select('source_index,url').eq('item_code', code);
  const { error: delErr } = await supabase.from('sku_sources').delete().eq('item_code', code);
  if (delErr) return { error: delErr.message };
  if (!clean.length) return { error: null };
  const rows = clean.map((url, i) => ({ item_code: code, source_index: i, url }));
  const { error } = await supabase.from('sku_sources').insert(rows);
  if (error) {
    const snapshot = (prev ?? []) as { source_index: number; url: string }[];
    if (snapshot.length) await supabase.from('sku_sources').insert(snapshot.map((r) => ({ item_code: code, source_index: r.source_index, url: r.url })));
    return { error: error.message };
  }
  return { error: null };
}

// ── shared-barcodes tab: the barcode_collisions view (0020) ──
export async function getSharedBarcodes(): Promise<CollisionRow[]> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase.from('barcode_collisions').select('barcode,n,item_codes').order('barcode').limit(1000);
  return (data ?? []) as CollisionRow[];
}
