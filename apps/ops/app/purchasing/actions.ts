'use server';

// Server actions for the Procurement module (the buying pipeline BEFORE Receiving). Same auth
// posture as the sales/fulfill/outbound/receiving actions: the SSR supabase client (anon key +
// the signed-in user's session), so RLS (is_allowed_user()) gates every read and write. The
// service-role key is never used here (the smoke harness uses it as a TEST harness only).
//
// PO / supplier / forwarder writes are single-table, direct RLS-gated writes; only shipment
// grouping (multi-row + the shipments upsert) goes through the group_pos_into_shipment RPC (0018).

import { createSupabaseServerClient } from '@jigzle/db/server';
import { customerLabel } from '@jigzle/lib';
import type {
  Forwarder,
  GroupShipmentInput,
  NewPOInput,
  OpenPORow,
  POOpenStatus,
  Supplier,
} from '@jigzle/db/types';
import type {
  CustomerHit,
  NewForwarderInput,
  UpdateForwarderPatch,
  NewSupplierInput,
  UpdateSupplierPatch,
  OpenPOFilter,
  OpenShipmentRow,
  SkuHit,
  UpdatePOPatch,
  PreorderRow,
  ReceivedItemRow,
  ShipmentHistoryRow,
  PlannedItemInput,
  PlannedItemRow,
  SoldOutRow,
  SkuStockInfo,
  Urgency,
} from './types';

const QUEUE_LIMIT = 200;
const HISTORY_LIMIT = 100;

// PostgREST `.or()` / `.ilike()` interpolate the raw string into a filter grammar where
// , ( ) * \ are operators. Strip them from operator-typed input (defense-in-depth — the
// operator is trusted, but never build a filter from unsanitized text).
function sanitize(q: string): string {
  return q.replace(/[,()*\\]/g, ' ').trim();
}

type CatNameRow = {
  item_code: string;
  translate_name: string | null;
  original_name: string | null;
  self_code: string | null;
};

function nameOf(c: CatNameRow | null, fallback: string): string {
  if (!c) return fallback;
  return c.translate_name || c.original_name || c.self_code || fallback;
}

// the catalogue's real display name, or null when it has none (a draft / uncatalogued stub). Lets the
// UI show an em dash instead of repeating the code as the "name". (PR77)
function realNameOf(c: CatNameRow | null): string | null {
  if (!c) return null;
  return c.translate_name || c.original_name || c.self_code || null;
}
const DASH = '—';

// today as a YYYY-MM-DD string in Asia/Jakarta (UTC+7, no DST) — matches the legacy date
// convention; the server runs in UTC on Vercel. (The grouping RPC uses current_date server-side.)
function todayJakarta(): string {
  const jkt = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return jkt.toISOString().slice(0, 10);
}

// ── the open-PO queue: purchase_orders not yet Received, newest first ──
// `or(status.is.null, status.neq.Received)` (not a bare `<> 'Received'`, which is NULL — not
// true — for NULL-status rows): the importer writes status NULL when a source status cell is
// blank/unrecognized, and those are still open POs that must show in the only open-PO surface.
export async function getOpenPOs(filter?: OpenPOFilter): Promise<OpenPORow[]> {
  const supabase = createSupabaseServerClient();
  let query = supabase
    .from('purchase_orders')
    .select(
      'po_id,item_code,item_code_raw,qty,status,status_since,ship_id,supplier_id,item_cost,method,marketplace_order_id,customer_id,item_note,product_link,input_date,tracking_to_forwarder,shipment_note'
    )
    .or('status.is.null,status.neq.Received')
    .order('po_id', { ascending: false })
    .limit(QUEUE_LIMIT);
  if (filter?.status) query = query.eq('status', filter.status);
  if (filter?.supplier_id) query = query.eq('supplier_id', filter.supplier_id);

  const { data, error } = await query;
  if (error || !data) return [];

  const rows = data as {
    po_id: number;
    item_code: string | null;
    item_code_raw: string | null;
    qty: number;
    status: OpenPORow['status'];
    status_since: string | null;
    ship_id: string | null;
    supplier_id: number | null;
    item_cost: number | null;
    method: string | null;
    marketplace_order_id: string | null;
    customer_id: number | null;
    item_note: string | null;
    product_link: string | null;
    input_date: string | null;
    tracking_to_forwarder: string | null;
    shipment_note: string | null;
  }[];

  // Resolve names in three small round-trips (catalogue, suppliers, customers).
  const codes = [...new Set(rows.map((r) => r.item_code).filter((c): c is string => !!c))];
  const supplierIds = [...new Set(rows.map((r) => r.supplier_id).filter((c): c is number => c != null))];
  const customerIds = [...new Set(rows.map((r) => r.customer_id).filter((c): c is number => c != null))];

  const nameByCode = new Map<string, string>();
  const supplierById = new Map<number, string | null>();
  const customerById = new Map<number, string | null>();

  await Promise.all([
    (async () => {
      if (!codes.length) return;
      const { data: cat } = await supabase
        .from('catalogue')
        .select('item_code,translate_name,original_name,self_code')
        .in('item_code', codes);
      for (const c of (cat ?? []) as CatNameRow[]) nameByCode.set(c.item_code, nameOf(c, c.item_code));
    })(),
    (async () => {
      if (!supplierIds.length) return;
      const { data: sup } = await supabase.from('suppliers').select('supplier_id,name').in('supplier_id', supplierIds);
      for (const s of (sup ?? []) as { supplier_id: number; name: string | null }[]) supplierById.set(s.supplier_id, s.name);
    })(),
    (async () => {
      if (!customerIds.length) return;
      const { data: cus } = await supabase.from('customers').select('customer_id,name,phone').in('customer_id', customerIds);
      for (const c of (cus ?? []) as { customer_id: number; name: string | null; phone: string | null }[]) customerById.set(c.customer_id, customerLabel(c.name, c.phone));
    })(),
  ]);

  return rows.map((r) => ({
    po_id: r.po_id,
    item_code: r.item_code,
    item_code_raw: r.item_code_raw,
    name: r.item_code ? nameByCode.get(r.item_code) ?? r.item_code : r.item_code_raw ?? '(no SKU)',
    qty: r.qty,
    status: r.status,
    status_since: r.status_since,
    ship_id: r.ship_id,
    supplier_id: r.supplier_id,
    supplier_name: r.supplier_id != null ? supplierById.get(r.supplier_id) ?? null : null,
    item_cost: r.item_cost,
    method: r.method,
    marketplace_order_id: r.marketplace_order_id,
    customer_id: r.customer_id,
    customer_name: r.customer_id != null ? customerById.get(r.customer_id) ?? null : null,
    item_note: r.item_note,
    product_link: r.product_link,
    input_date: r.input_date,
    tracking_to_forwarder: r.tracking_to_forwarder,
    shipment_note: r.shipment_note,
  }));
}

// ── supplier / forwarder / open-shipment lists for the form dropdowns ──
export async function getSuppliers(): Promise<Supplier[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('suppliers')
    .select('supplier_id,name,country,flag,type,sort_order,is_active,created_at')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error || !data) return [];
  return data as Supplier[];
}

// ── Settings → Suppliers: persist a manual order (sort_order = array index) ──
export async function reorderSuppliers(orderedIds: number[]): Promise<void> {
  if (!orderedIds.length) return;
  const supabase = createSupabaseServerClient();
  const results = await Promise.all(
    orderedIds.map((id, i) => supabase.from('suppliers').update({ sort_order: i }).eq('supplier_id', id))
  );
  const failed = results.find((r) => r.error);
  if (failed?.error) throw new Error(`reorderSuppliers: ${failed.error.message}`);
}

export async function getForwarders(): Promise<Forwarder[]> {
  const supabase = createSupabaseServerClient();
  // active forwarders only (soft-deleted ones stay resolvable for history but drop from the pickers),
  // in the manual Settings order (sort_order, then prefix as a stable tiebreak).
  const { data, error } = await supabase
    .from('forwarders')
    .select('prefix,name,country,flag,sort_order,is_active,created_at')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('prefix', { ascending: true });
  if (error || !data) return [];
  return data as Forwarder[];
}

// ── the next ship_id for a forwarder prefix: highest numeric suffix seen on that prefix + 1 ──
// Powers the To-ship group panel's auto-fill: pick a forwarder → its next running number appears.
// Ship_ids are messy (spaces, occasional embedded "\n#tracking"), so we scan by prefix and parse the
// first number after it in JS rather than trusting a single format. Zero-pads to the prefix's observed
// width (e.g. MTE → "005", SUB → "193") so new ids match the existing sequence.
export async function getNextShipId(prefix: string): Promise<string> {
  const p = prefix.trim().toUpperCase();
  if (!p) return '';
  const supabase = createSupabaseServerClient();
  const { data } = await supabase.from('shipments').select('ship_id').ilike('ship_id', `${p}%`);
  let max = 0;
  let width = 3; // sensible default pad
  for (const row of (data ?? []) as { ship_id: string }[]) {
    const m = new RegExp(`^${p}\\s*0*(\\d+)`, 'i').exec((row.ship_id ?? '').trim());
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n)) {
      if (n > max) max = n;
      width = Math.max(width, m[1].length);
    }
  }
  return `${p} ${String(max + 1).padStart(width, '0')}`;
}

export async function getOpenShipments(): Promise<OpenShipmentRow[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('shipments')
    .select('ship_id,forwarder_prefix,origin_country,ship_date')
    .eq('status', 'open')
    .order('ship_date', { ascending: false, nullsFirst: false })
    .limit(QUEUE_LIMIT);
  if (error || !data) return [];
  return data as OpenShipmentRow[];
}

// ── SKU search (catalogue text + barcode + brand name), with live available + incoming (D3) ──
// (SkuHit in ./types). PR73: the add-item search also matches on brand — brands.name → brand_prefix →
// catalogue.brand_prefix — so "lego", a piece count, a code, a name, or a barcode all resolve a SKU.
export async function searchSkus(q: string): Promise<SkuHit[]> {
  const raw = sanitize(q);
  if (raw.length < 2) return [];
  const supabase = createSupabaseServerClient();

  // resolve brand prefixes whose name matches the query (for the brand-name search arm)
  const { data: brandRows } = await supabase.from('brands').select('prefix').ilike('name', `%${raw}%`).limit(20);
  const brandPrefixes = [...new Set((brandRows ?? []).map((b) => b.prefix as string))];

  const named = new Map<string, string | null>();
  const [catRes, bcRes, brandCatRes] = await Promise.all([
    supabase
      .from('catalogue')
      .select('item_code,original_name,translate_name,self_code,brand_prefix')
      .or(`item_code.ilike.%${raw}%,self_code.ilike.%${raw}%,original_name.ilike.%${raw}%,translate_name.ilike.%${raw}%,piece_count.ilike.%${raw}%`)
      .limit(15),
    supabase.from('barcodes').select('item_code').ilike('barcode', `%${raw}%`).limit(15),
    brandPrefixes.length
      ? supabase.from('catalogue').select('item_code,original_name,translate_name,self_code,brand_prefix').in('brand_prefix', brandPrefixes).limit(15)
      : Promise.resolve({ data: [] as CatRow[] }),
  ]);

  type CatRow = CatNameRow & { brand_prefix: string | null };
  const brandByCode = new Map<string, string | null>();
  const absorb = (rows: CatRow[]) => {
    for (const c of rows) { named.set(c.item_code, realNameOf(c)); brandByCode.set(c.item_code, c.brand_prefix); }
  };
  absorb((catRes.data ?? []) as CatRow[]);
  absorb((brandCatRes.data ?? []) as CatRow[]);

  const bcCodes = [...new Set((bcRes.data ?? []).map((b) => b.item_code as string))].filter((code) => !named.has(code));
  if (bcCodes.length) {
    const { data: cat2 } = await supabase
      .from('catalogue')
      .select('item_code,original_name,translate_name,self_code,brand_prefix')
      .in('item_code', bcCodes);
    absorb((cat2 ?? []) as CatRow[]);
  }

  const codes = [...named.keys()].slice(0, 20);
  if (!codes.length) return [];

  // resolve brand display names for the matched SKUs (prefix → name)
  const prefixes = [...new Set([...brandByCode.values()].filter((p): p is string => !!p))];
  const brandName = new Map<string, string>();
  if (prefixes.length) {
    const { data: bn } = await supabase.from('brands').select('prefix,name').in('prefix', prefixes);
    for (const b of (bn ?? []) as { prefix: string; name: string | null }[]) if (b.name) brandName.set(b.prefix, b.name);
  }

  // the three pipeline figures per code (warehouse / at-forwarder / shipped) — same source the
  // selected-item view and the cards use, so the search result reads identically (a quick-view).
  const pipe = await pipelineFor(supabase, codes);

  return codes.map((item_code) => {
    const e = pipe.get(item_code) ?? { available: 0, pending: 0, on_the_way: 0, with_forwarder: 0 };
    const prefix = brandByCode.get(item_code) ?? null;
    return {
      item_code,
      name: named.get(item_code) ?? DASH,
      brand: prefix ? brandName.get(prefix) ?? prefix : null,
      available: e.available,
      pending: e.pending,
      with_forwarder: e.with_forwarder,
      on_the_way: e.on_the_way,
    };
  });
}

// ── PR73: the buy links for one SKU shown in the To-buy "Buy" overlay: the catalogue's stored supplier
// sources (sku_sources, ordered). The card's own product_link (manual) / item_link (preorder) is passed
// separately by the client — this fills in the catalogue fallback ("draws from the catalog database"). ──
export async function getSkuSources(itemCode: string): Promise<string[]> {
  const code = itemCode.trim();
  if (!code) return [];
  const supabase = createSupabaseServerClient();
  const { data } = await supabase
    .from('sku_sources')
    .select('url,source_index')
    .eq('item_code', code)
    .order('source_index', { ascending: true });
  return [...new Set(((data ?? []) as { url: string }[]).map((r) => r.url).filter(Boolean))];
}

// ── customer search (name + phone) for the optional "for customer" field ── (CustomerHit in ./types)
export async function searchCustomers(q: string): Promise<CustomerHit[]> {
  const raw = sanitize(q);
  if (raw.length < 2) return [];
  const supabase = createSupabaseServerClient();

  const digits = raw.replace(/\D/g, '');
  const filters = [`name.ilike.%${raw}%`, `phone_raw.ilike.%${raw}%`];
  if (digits.length >= 3) filters.push(`phone.ilike.%${digits}%`);

  const { data } = await supabase.from('customers').select('customer_id,name,phone').or(filters.join(',')).limit(20);
  return ((data ?? []) as { customer_id: number; name: string | null; phone: string | null }[]).map((c) => ({
    customer_id: c.customer_id,
    name: c.name,
    phone: c.phone,
  }));
}

// ── create a PO (status → Processing). supplier_id + item_code required, qty >= 0 ──
export async function createPO(input: NewPOInput): Promise<{ po_id: number }> {
  const supabase = createSupabaseServerClient();
  const supplier_id = input.supplier_id;
  const item_code = input.item_code?.trim();
  if (!supplier_id) throw new Error('createPO: a supplier is required');
  if (!item_code) throw new Error('createPO: an item code is required');
  const qty = Number(input.qty);
  if (!Number.isFinite(qty) || qty < 0) throw new Error('createPO: qty must be a number >= 0');

  const today = todayJakarta();
  const { data, error } = await supabase
    .from('purchase_orders')
    .insert({
      supplier_id,
      item_code,
      qty,
      status: 'Processing',
      status_since: today,
      input_date: today,
      item_cost: input.item_cost ?? null,
      method: input.method?.trim() || null,
      marketplace_order_id: input.marketplace_order_id?.trim() || null,
      customer_id: input.customer_id ?? null,
      item_note: input.item_note?.trim() || null,
    })
    .select('po_id')
    .single();
  if (error) throw new Error(`createPO: ${error.message}`);
  return { po_id: (data as { po_id: number }).po_id };
}

// fetch the current status guarding edits — a Received PO is owned by Receiving, never edited here.
async function assertNotReceived(supabase: ReturnType<typeof createSupabaseServerClient>, poId: number, who: string): Promise<void> {
  const { data } = await supabase.from('purchase_orders').select('status').eq('po_id', poId).maybeSingle();
  if (!data) throw new Error(`${who}: PO ${poId} not found`);
  if ((data as { status: string | null }).status === 'Received') throw new Error(`${who}: PO ${poId} is Received — owned by Receiving`);
}

// ── edit an open PO (blocked once Received). ship_id: null detaches from the shipment ──
export async function updatePO(poId: number, patch: UpdatePOPatch): Promise<void> {
  const supabase = createSupabaseServerClient();
  await assertNotReceived(supabase, poId, 'updatePO');

  const upd: Record<string, unknown> = {};
  if (patch.supplier_id !== undefined) {
    if (!patch.supplier_id) throw new Error('updatePO: a supplier is required');
    upd.supplier_id = patch.supplier_id;
  }
  if (patch.item_code !== undefined) {
    const code = patch.item_code?.trim();
    if (!code) throw new Error('updatePO: an item code is required');
    upd.item_code = code;
  }
  if (patch.qty !== undefined) {
    const qty = Number(patch.qty);
    if (!Number.isFinite(qty) || qty < 0) throw new Error('updatePO: qty must be a number >= 0');
    upd.qty = qty;
  }
  if (patch.item_cost !== undefined) upd.item_cost = patch.item_cost;
  if (patch.method !== undefined) upd.method = patch.method?.trim() || null;
  if (patch.marketplace_order_id !== undefined) upd.marketplace_order_id = patch.marketplace_order_id?.trim() || null;
  if (patch.customer_id !== undefined) upd.customer_id = patch.customer_id ?? null;
  if (patch.item_note !== undefined) upd.item_note = patch.item_note?.trim() || null;
  if (patch.product_link !== undefined) upd.product_link = patch.product_link?.trim() || null;
  if (patch.tracking_to_forwarder !== undefined) upd.tracking_to_forwarder = patch.tracking_to_forwarder?.trim() || null;
  if (patch.ship_id !== undefined) upd.ship_id = patch.ship_id?.trim() || null;

  if (Object.keys(upd).length === 0) return;
  const { error } = await supabase.from('purchase_orders').update(upd).eq('po_id', poId);
  if (error) throw new Error(`updatePO: ${error.message}`);
}

// ── advance a PO among the three open states (Receiving owns 'Received'); stamps status_since ──
export async function setPOStatus(poId: number, status: POOpenStatus): Promise<void> {
  const ALLOWED: POOpenStatus[] = ['Processing', 'On the way', 'With Forwarder'];
  if (!ALLOWED.includes(status)) {
    throw new Error(`setPOStatus: '${status}' is not settable here (Receiving owns 'Received')`);
  }
  const supabase = createSupabaseServerClient();
  await assertNotReceived(supabase, poId, 'setPOStatus');
  const { error } = await supabase
    .from('purchase_orders')
    .update({ status, status_since: todayJakarta() })
    .eq('po_id', poId);
  if (error) throw new Error(`setPOStatus: ${error.message}`);
}

// ── delete an open PO (an order that won't be confirmed). Open POs are incoming-only (they feed the
// pending / on-the-way stock columns, not actual stock), so removing one just drops it from those
// counts. Received POs are owned by Receiving and never deleted here. ──
export async function deletePO(poId: number): Promise<void> {
  const supabase = createSupabaseServerClient();
  await assertNotReceived(supabase, poId, 'deletePO');
  const { error } = await supabase.from('purchase_orders').delete().eq('po_id', poId);
  if (error) throw new Error(`deletePO: ${error.message}`);
}

// ── To buy → Planned: create a manual buy-list item (PO status 'Planned', no supplier yet). ──
export async function createPlannedItem(input: PlannedItemInput): Promise<{ po_id: number }> {
  const supabase = createSupabaseServerClient();
  const item_code = input.item_code?.trim();
  if (!item_code) throw new Error('createPlannedItem: an item code is required');
  const qty = Number(input.qty);
  if (!Number.isFinite(qty) || qty < 0) throw new Error('createPlannedItem: qty must be a number >= 0');

  const urgency = input.urgency && ['low', 'mid', 'high'].includes(input.urgency) ? input.urgency : null;
  const today = todayJakarta();
  const { data, error } = await supabase
    .from('purchase_orders')
    .insert({
      item_code,
      qty,
      status: 'Planned',
      status_since: today,
      input_date: today,
      product_link: input.product_link?.trim() || null,
      item_note: input.item_note?.trim() || null,
      urgency,
    })
    .select('po_id')
    .single();
  if (error) throw new Error(`createPlannedItem: ${error.message}`);
  return { po_id: (data as { po_id: number }).po_id };
}

// ── PR75: stub a brand-new SKU as a draft catalogue row (the add-item flow). It's a real catalogue row
// so a PO can FK to it; is_draft + needs_review mark it as a not-yet-completed stub (the Catalog screen
// enriches it later). The SKU code is the identifier — a name is optional. Idempotent on the code.
// (region was dropped in 0010, so the only required column is item_code.) ──
export async function createDraftSku(input: { item_code: string; name?: string | null }): Promise<{ item_code: string; name: string }> {
  const supabase = createSupabaseServerClient();
  const item_code = input.item_code?.trim();
  const name = input.name?.trim() || null;
  if (!item_code) throw new Error('createDraftSku: an item code is required');

  const { data: existing } = await supabase
    .from('catalogue')
    .select('item_code,translate_name,original_name,self_code')
    .eq('item_code', item_code)
    .maybeSingle();
  if (existing) return { item_code, name: nameOf(existing as CatNameRow, item_code) };

  const { error } = await supabase
    .from('catalogue')
    .insert({ item_code, translate_name: name, is_draft: true, needs_review: true });
  if (error) throw new Error(`createDraftSku: ${error.message}`);
  return { item_code, name: name ?? item_code };
}

// ── PR73: set the qty of a manual (Planned) buy-list item — the card's editable ± stepper. Reuses the
// guarded updatePO path (blocked once Received; qty must be a number ≥ 0). ──
export async function setPlannedQty(poId: number, qty: number): Promise<void> {
  await updatePO(poId, { qty });
}

// ── PR73: mark a SKU sold out straight from the From-Sales card (no PO exists yet) by creating a
// 'Sold out' PO for that item + customer. It then both shows in the Out-of-Stock list and covers the
// preorder (an open, non-Received PO for the SKU + customer), so the line drops off From Sales. ──
export async function markSkuSoldOut(input: { item_code: string; customer_id: number | null; qty: number; sales_id?: string | null; note?: string | null }): Promise<{ po_id: number }> {
  const supabase = createSupabaseServerClient();
  const item_code = input.item_code?.trim();
  if (!item_code) throw new Error('markSkuSoldOut: an item code is required');
  const qty = Number(input.qty);
  const today = todayJakarta();
  const { data, error } = await supabase
    .from('purchase_orders')
    .insert({
      item_code,
      qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
      status: 'Sold out',
      status_since: today,
      input_date: today,
      sold_out_date: today,
      sold_out_note: input.note?.trim() || null,
      customer_id: input.customer_id ?? null,
      // keep the originating sale so the Out-of-Stock card can show order id / date (sales origin)
      marketplace_order_id: input.sales_id?.trim() || null,
    })
    .select('po_id')
    .single();
  if (error) throw new Error(`markSkuSoldOut: ${error.message}`);
  return { po_id: (data as { po_id: number }).po_id };
}

// ── Buy a preorder (decision #2): create a Processing PO linked to the customer who ordered it, so it
// enters To forwarder and drops off the preorder list (covered by an open PO for that SKU + customer). ──
export async function buyPreorder(input: { item_code: string; qty: number; customer_id: number | null }): Promise<{ po_id: number }> {
  const supabase = createSupabaseServerClient();
  const item_code = input.item_code?.trim();
  if (!item_code) throw new Error('buyPreorder: an item code is required');
  const qty = Number(input.qty);
  const today = todayJakarta();
  const { data, error } = await supabase
    .from('purchase_orders')
    .insert({
      item_code,
      qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
      status: 'Processing',
      status_since: today,
      input_date: today,
      customer_id: input.customer_id ?? null,
    })
    .select('po_id')
    .single();
  if (error) throw new Error(`buyPreorder: ${error.message}`);
  return { po_id: (data as { po_id: number }).po_id };
}

// ── mark / unmark a PO sold out. soldOut=true → status 'Sold out' (auto-date + optional reason);
// false → back to 'Planned' (clears the date/note). ──
export async function setSoldOut(poId: number, soldOut: boolean, note?: string | null): Promise<void> {
  const supabase = createSupabaseServerClient();
  await assertNotReceived(supabase, poId, 'setSoldOut');
  const upd = soldOut
    ? { status: 'Sold out', status_since: todayJakarta(), sold_out_date: todayJakarta(), sold_out_note: note?.trim() || null }
    : { status: 'Planned', status_since: todayJakarta(), sold_out_date: null, sold_out_note: null };
  const { error } = await supabase.from('purchase_orders').update(upd).eq('po_id', poId);
  if (error) throw new Error(`setSoldOut: ${error.message}`);
}

// pipeline figures per SKU: live warehouse availability + incoming PO qty split by status
// (pending = Σ Processing, with_forwarder = Σ 'With Forwarder', on_the_way = Σ 'On the way').
type PipeFig = { available: number; pending: number; on_the_way: number; with_forwarder: number };
async function pipelineFor(supabase: ReturnType<typeof createSupabaseServerClient>, codes: string[]): Promise<Map<string, PipeFig>> {
  const m = new Map<string, PipeFig>();
  for (const c of codes) m.set(c, { available: 0, pending: 0, on_the_way: 0, with_forwarder: 0 });
  if (!codes.length) return m;
  await Promise.all([
    (async () => {
      const { data } = await supabase.from('stock_check').select('item_code,available').in('item_code', codes);
      for (const s of (data ?? []) as { item_code: string; available: number }[]) {
        const e = m.get(s.item_code); if (e) e.available = Number(s.available) || 0;
      }
    })(),
    (async () => {
      const { data } = await supabase.from('purchase_orders').select('item_code,qty,status').in('item_code', codes).in('status', ['Processing', 'On the way', 'With Forwarder']);
      for (const p of (data ?? []) as { item_code: string | null; qty: number | null; status: string | null }[]) {
        if (!p.item_code) continue;
        const e = m.get(p.item_code); if (!e) continue;
        if (p.status === 'Processing') e.pending += Number(p.qty) || 0;
        else if (p.status === 'On the way') e.on_the_way += Number(p.qty) || 0;
        else if (p.status === 'With Forwarder') e.with_forwarder += Number(p.qty) || 0;
      }
    })(),
  ]);
  return m;
}

// live stock figures for one SKU (the add-item overlay).
export async function getSkuStock(itemCode: string): Promise<SkuStockInfo> {
  const code = itemCode.trim();
  const supabase = createSupabaseServerClient();
  const m = await pipelineFor(supabase, code ? [code] : []);
  const e = m.get(code) ?? { available: 0, on_the_way: 0, with_forwarder: 0 };
  return { item_code: code, available: e.available, on_the_way: e.on_the_way, with_forwarder: e.with_forwarder };
}

// ── To buy → Planned list (PO status 'Planned'), newest first, with live stock figures. ──
export async function getPlannedItems(): Promise<PlannedItemRow[]> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase
    .from('purchase_orders')
    .select('po_id,item_code,qty,product_link,item_note,urgency,status,status_since')
    .eq('status', 'Planned')
    .order('po_id', { ascending: false })
    .limit(QUEUE_LIMIT);
  const rows = (data ?? []) as { po_id: number; item_code: string | null; qty: number; product_link: string | null; item_note: string | null; urgency: Urgency | null }[];
  if (!rows.length) return [];

  const codes = [...new Set(rows.map((r) => r.item_code).filter((c): c is string => !!c))];
  const nameByCode = new Map<string, string>();
  if (codes.length) {
    const { data: cat } = await supabase.from('catalogue').select('item_code,translate_name,original_name,self_code').in('item_code', codes);
    for (const c of (cat ?? []) as CatNameRow[]) { const n = realNameOf(c); if (n) nameByCode.set(c.item_code, n); }
  }
  const pipe = await pipelineFor(supabase, codes);

  return rows.map((r) => {
    const p = (r.item_code && pipe.get(r.item_code)) || { available: 0, on_the_way: 0, with_forwarder: 0 };
    return {
      po_id: r.po_id,
      item_code: r.item_code,
      name: r.item_code ? nameByCode.get(r.item_code) ?? DASH : DASH,
      qty: r.qty,
      product_link: r.product_link,
      item_note: r.item_note,
      urgency: r.urgency,
      available: p.available,
      on_the_way: p.on_the_way,
      with_forwarder: p.with_forwarder,
    };
  });
}

// ── To buy → Sold out list (PO status 'Sold out'), newest sold-out first. ──
export async function getSoldOutItems(): Promise<SoldOutRow[]> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase
    .from('purchase_orders')
    .select('po_id,item_code,qty,product_link,urgency,sold_out_date,sold_out_note,customer_id,marketplace_order_id,status')
    .eq('status', 'Sold out')
    .order('sold_out_date', { ascending: false, nullsFirst: false })
    .order('po_id', { ascending: false })
    .limit(QUEUE_LIMIT);
  const rows = (data ?? []) as {
    po_id: number; item_code: string | null; qty: number; product_link: string | null; urgency: Urgency | null;
    sold_out_date: string | null; sold_out_note: string | null; customer_id: number | null; marketplace_order_id: string | null;
  }[];
  if (!rows.length) return [];

  const codes = [...new Set(rows.map((r) => r.item_code).filter((c): c is string => !!c))];
  const salesIds = [...new Set(rows.map((r) => r.marketplace_order_id).filter((s): s is string => !!s))];
  const customerIds = [...new Set(rows.map((r) => r.customer_id).filter((c): c is number => c != null))];

  const nameByCode = new Map<string, string>();
  const orderDateById = new Map<string, string | null>();
  const customerById = new Map<number, string | null>();
  const pipe = await pipelineFor(supabase, codes); // figures for manual-origin rows
  await Promise.all([
    (async () => {
      if (!codes.length) return;
      const { data: cat } = await supabase.from('catalogue').select('item_code,translate_name,original_name,self_code').in('item_code', codes);
      for (const c of (cat ?? []) as CatNameRow[]) { const n = realNameOf(c); if (n) nameByCode.set(c.item_code, n); }
    })(),
    (async () => {
      if (!salesIds.length) return;
      const { data: ord } = await supabase.from('orders').select('sales_id,order_date').in('sales_id', salesIds);
      for (const o of (ord ?? []) as { sales_id: string; order_date: string | null }[]) orderDateById.set(o.sales_id, o.order_date);
    })(),
    (async () => {
      if (!customerIds.length) return;
      const { data: cus } = await supabase.from('customers').select('customer_id,name,phone').in('customer_id', customerIds);
      for (const c of (cus ?? []) as { customer_id: number; name: string | null; phone: string | null }[]) customerById.set(c.customer_id, customerLabel(c.name, c.phone));
    })(),
  ]);

  return rows.map((r) => {
    const p = (r.item_code && pipe.get(r.item_code)) || { available: 0, on_the_way: 0, with_forwarder: 0 };
    // sales origin = it carries the originating sale (stored in marketplace_order_id by markSkuSoldOut)
    const origin: 'manual' | 'sales' = r.marketplace_order_id ? 'sales' : 'manual';
    return {
      po_id: r.po_id,
      item_code: r.item_code,
      name: r.item_code ? nameByCode.get(r.item_code) ?? DASH : DASH,
      qty: r.qty,
      product_link: r.product_link,
      urgency: r.urgency,
      sold_out_date: r.sold_out_date,
      sold_out_note: r.sold_out_note,
      origin,
      sales_id: r.marketplace_order_id,
      customer_name: r.customer_id != null ? customerById.get(r.customer_id) ?? null : null,
      order_date: r.marketplace_order_id ? orderDateById.get(r.marketplace_order_id) ?? null : null,
      available: p.available,
      with_forwarder: p.with_forwarder,
      on_the_way: p.on_the_way,
    };
  });
}

// ── inline "+ add" supplier (idempotent on the unique name) ──
export async function addSupplier(input: NewSupplierInput): Promise<Supplier> {
  const supabase = createSupabaseServerClient();
  const name = input.name?.trim();
  if (!name) throw new Error('addSupplier: a name is required');

  // re-adding a name that exists: return it (reactivating it first if it was soft-deleted), so a
  // removed supplier can be brought back without a duplicate-name collision.
  const { data: existing } = await supabase.from('suppliers').select('*').eq('name', name).maybeSingle();
  if (existing) {
    if ((existing as Supplier).is_active === false) {
      const { data: re } = await supabase.from('suppliers').update({ is_active: true }).eq('supplier_id', (existing as Supplier).supplier_id).select('*').single();
      return (re ?? existing) as Supplier;
    }
    return existing as Supplier;
  }

  // append to the end of the manual order
  const { data: top } = await supabase.from('suppliers').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle();
  const nextOrder = ((top?.sort_order as number | null) ?? -1) + 1;

  const { data, error } = await supabase
    .from('suppliers')
    .insert({
      name,
      country: input.country?.trim() || null,
      flag: input.flag?.trim() || null,
      type: input.type ?? null,
      sort_order: nextOrder,
    })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') {
      const { data: e2 } = await supabase.from('suppliers').select('*').eq('name', name).maybeSingle();
      if (e2) return e2 as Supplier;
    }
    throw new Error(`addSupplier: ${error.message}`);
  }
  return data as Supplier;
}

// ── edit a supplier (Settings → Suppliers). Whitelisted fields only; name stays unique. ──
export async function updateSupplier(supplierId: number, patch: UpdateSupplierPatch): Promise<Supplier> {
  const supabase = createSupabaseServerClient();
  const upd: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name?.trim();
    if (!name) throw new Error('updateSupplier: a name is required');
    upd.name = name;
  }
  if (patch.country !== undefined) upd.country = patch.country?.trim() || null;
  if (patch.flag !== undefined) upd.flag = patch.flag?.trim() || null;
  if (patch.type !== undefined) upd.type = patch.type ?? null;

  const { data, error } = await supabase.from('suppliers').update(upd).eq('supplier_id', supplierId).select('*').single();
  if (error) {
    if (error.code === '23505') throw new Error('updateSupplier: a supplier with that name already exists');
    throw new Error(`updateSupplier: ${error.message}`);
  }
  return data as Supplier;
}

// ── delete a supplier (Settings → Suppliers): a SOFT delete (is_active = false). Historical POs keep
// their supplier_id and still resolve the supplier's name from this table, so removing one never
// touches past orders — it just drops out of the picker + the settings list. ──
export async function deleteSupplier(supplierId: number): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from('suppliers').update({ is_active: false }).eq('supplier_id', supplierId);
  if (error) throw new Error(`deleteSupplier: ${error.message}`);
}

// ── add a forwarder (Settings → Forwarders; idempotent on the prefix PK). Reactivates a soft-deleted
// prefix rather than colliding on it. New rows append to the end of the manual order. ──
export async function addForwarder(input: NewForwarderInput): Promise<Forwarder> {
  const supabase = createSupabaseServerClient();
  const prefix = input.prefix?.trim();
  if (!prefix) throw new Error('addForwarder: a prefix is required');

  const { data: existing } = await supabase.from('forwarders').select('*').eq('prefix', prefix).maybeSingle();
  if (existing) {
    const ex = existing as Forwarder;
    if (!ex.is_active) {
      const { data: re } = await supabase.from('forwarders').update({ is_active: true }).eq('prefix', prefix).select('*').single();
      if (re) return re as Forwarder;
    }
    return ex;
  }

  const { data: top } = await supabase.from('forwarders').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle();
  const nextOrder = ((top?.sort_order as number | null) ?? -1) + 1;

  const { data, error } = await supabase
    .from('forwarders')
    .insert({
      prefix,
      name: input.name?.trim() || null,
      country: input.country?.trim() || null,
      flag: input.flag?.trim() || null,
      sort_order: nextOrder,
    })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') {
      const { data: e2 } = await supabase.from('forwarders').select('*').eq('prefix', prefix).maybeSingle();
      if (e2) return e2 as Forwarder;
    }
    throw new Error(`addForwarder: ${error.message}`);
  }
  return data as Forwarder;
}

// ── edit a forwarder (Settings → Forwarders). Whitelisted fields; prefix (PK) is immutable. ──
export async function updateForwarder(prefix: string, patch: UpdateForwarderPatch): Promise<Forwarder> {
  const supabase = createSupabaseServerClient();
  const upd: Record<string, unknown> = {};
  if (patch.name !== undefined) upd.name = patch.name?.trim() || null;
  if (patch.country !== undefined) upd.country = patch.country?.trim() || null;
  if (patch.flag !== undefined) upd.flag = patch.flag?.trim() || null;
  const { data, error } = await supabase.from('forwarders').update(upd).eq('prefix', prefix).select('*').single();
  if (error) throw new Error(`updateForwarder: ${error.message}`);
  return data as Forwarder;
}

// ── reorder forwarders (Settings → Forwarders): persist the manual order (index → sort_order). ──
export async function reorderForwarders(prefixes: string[]): Promise<void> {
  const supabase = createSupabaseServerClient();
  await Promise.all(
    prefixes.map((prefix, i) => supabase.from('forwarders').update({ sort_order: i }).eq('prefix', prefix))
  );
}

// ── delete a forwarder (Settings → Forwarders): SOFT delete (is_active = false). Historical shipments
// keep their forwarder_prefix and still resolve; the forwarder just drops from the pickers + settings. ──
export async function deleteForwarder(prefix: string): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from('forwarders').update({ is_active: false }).eq('prefix', prefix);
  if (error) throw new Error(`deleteForwarder: ${error.message}`);
}

// ── group selected POs into a forwarder shipment (atomic, via the RPC) → updated po_ids ──
export async function groupIntoShipment(payload: GroupShipmentInput): Promise<{ affected: number[] }> {
  if (!payload.po_ids?.length) throw new Error('groupIntoShipment: select at least one PO');
  const ship_id = payload.ship_id?.trim();
  if (!ship_id) throw new Error('groupIntoShipment: a ship id is required');
  const forwarder_prefix = payload.forwarder_prefix?.trim();
  if (!forwarder_prefix) throw new Error('groupIntoShipment: a forwarder is required');

  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('group_pos_into_shipment', {
    p_ship_id: ship_id,
    p_po_ids: payload.po_ids,
    p_forwarder_prefix: forwarder_prefix,
    p_origin_country: payload.origin_country?.trim() || null,
    p_ship_date: payload.ship_date || null,
  });
  if (error) throw new Error(`groupIntoShipment: ${error.message}`);
  return { affected: (data as number[] | null) ?? [] };
}

// ── To buy → Preorder (read-only): unfulfilled, non-cancelled sales lines whose SKU is ≤0 available —
// what customers ordered that we must still buy. Newest order first. (types in ./types) ──
export async function getPreorders(): Promise<PreorderRow[]> {
  const supabase = createSupabaseServerClient();

  // unfulfilled, live order lines with a resolved SKU (no stock gate exists for code-less lines)
  const { data: lines } = await supabase
    .from('order_lines')
    .select('line_id,sales_id,item_code,qty,item_link')
    .is('fulfilled_at', null)
    .eq('is_cancelled', false)
    .not('item_code', 'is', null)
    .limit(1000);
  const rows = (lines ?? []) as { line_id: string; sales_id: string; item_code: string; qty: number; item_link: string | null }[];
  if (!rows.length) return [];

  const salesIds = [...new Set(rows.map((r) => r.sales_id))];
  const codes = [...new Set(rows.map((r) => r.item_code))];

  // orders (skip Cancelled/Complete), catalogue names, customers, and live availability — in parallel
  const orderById = new Map<string, { order_date: string | null; status: string | null; customer_id: number | null; urgency: Urgency | null }>();
  const nameByCode = new Map<string, string>();
  const availByCode = new Map<string, number>();
  const customerById = new Map<number, string | null>();

  await Promise.all([
    (async () => {
      const { data } = await supabase.from('orders').select('sales_id,order_date,status,customer_id,urgency').in('sales_id', salesIds);
      for (const o of (data ?? []) as { sales_id: string; order_date: string | null; status: string | null; customer_id: number | null; urgency: Urgency | null }[]) {
        orderById.set(o.sales_id, { order_date: o.order_date, status: o.status, customer_id: o.customer_id, urgency: o.urgency });
      }
    })(),
    (async () => {
      const { data } = await supabase.from('catalogue').select('item_code,translate_name,original_name,self_code').in('item_code', codes);
      for (const c of (data ?? []) as CatNameRow[]) nameByCode.set(c.item_code, nameOf(c, c.item_code));
    })(),
    (async () => {
      const { data } = await supabase.from('stock_check').select('item_code,available').in('item_code', codes);
      for (const s of (data ?? []) as { item_code: string; available: number }[]) availByCode.set(s.item_code, Number(s.available) || 0);
    })(),
  ]);

  const customerIds = [...new Set([...orderById.values()].map((o) => o.customer_id).filter((c): c is number => c != null))];
  if (customerIds.length) {
    const { data } = await supabase.from('customers').select('customer_id,name,phone').in('customer_id', customerIds);
    for (const c of (data ?? []) as { customer_id: number; name: string | null; phone: string | null }[]) customerById.set(c.customer_id, customerLabel(c.name, c.phone));
  }

  // a preorder drops once an OPEN PO for the same SKU + customer covers it (decision #2). Key by
  // `item_code|customer_id` (customer-less POs don't cover a customer's preorder).
  const coveredKeys = new Set<string>();
  {
    const { data } = await supabase
      .from('purchase_orders')
      .select('item_code,customer_id,status')
      .in('item_code', codes)
      .not('customer_id', 'is', null)
      .or('status.is.null,status.neq.Received');
    for (const p of (data ?? []) as { item_code: string | null; customer_id: number | null }[]) {
      if (p.item_code && p.customer_id != null) coveredKeys.add(`${p.item_code}|${p.customer_id}`);
    }
  }

  const out: PreorderRow[] = [];
  for (const r of rows) {
    const order = orderById.get(r.sales_id);
    if (!order || order.status === 'Cancelled' || order.status === 'Complete') continue;
    const available = availByCode.get(r.item_code) ?? 0;
    if (available > 0) continue; // in stock → not a preorder
    if (order.customer_id != null && coveredKeys.has(`${r.item_code}|${order.customer_id}`)) continue; // already on order
    out.push({
      line_id: r.line_id,
      sales_id: r.sales_id,
      customer_id: order.customer_id,
      customer_name: order.customer_id != null ? customerById.get(order.customer_id) ?? null : null,
      order_date: order.order_date,
      item_code: r.item_code,
      name: nameByCode.get(r.item_code) ?? r.item_code,
      qty: r.qty,
      available,
      urgency: order.urgency,
      product_link: r.item_link,
    });
  }
  // newest order first (nulls last), then sales_id for stability
  out.sort((a, b) => {
    if (a.order_date && b.order_date) return a.order_date < b.order_date ? 1 : a.order_date > b.order_date ? -1 : a.sales_id.localeCompare(b.sales_id);
    if (a.order_date) return -1;
    if (b.order_date) return 1;
    return a.sales_id.localeCompare(b.sales_id);
  });
  return out;
}

// ── History → Per item (read-only): Received PO lines, newest first; keeps per-item cost / shipID.
// Optional text filter matches item_code / name / ship_id. (types in ./types) ──
export async function getReceivedItems(query = ''): Promise<ReceivedItemRow[]> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase
    .from('purchase_orders')
    .select('po_id,item_code,item_code_raw,qty,status,item_cost,ship_id,supplier_id,receive_date,marketplace_order_id,product_link')
    .eq('status', 'Received')
    .order('receive_date', { ascending: false, nullsFirst: false })
    .order('po_id', { ascending: false })
    .limit(500);
  const rows = (data ?? []) as {
    po_id: number; item_code: string | null; item_code_raw: string | null; qty: number; item_cost: number | null;
    ship_id: string | null; supplier_id: number | null; receive_date: string | null; marketplace_order_id: string | null; product_link: string | null;
  }[];
  if (!rows.length) return [];

  const codes = [...new Set(rows.map((r) => r.item_code).filter((c): c is string => !!c))];
  const supplierIds = [...new Set(rows.map((r) => r.supplier_id).filter((c): c is number => c != null))];
  const nameByCode = new Map<string, string>();
  const supplierById = new Map<number, string | null>();
  await Promise.all([
    (async () => {
      if (!codes.length) return;
      const { data } = await supabase.from('catalogue').select('item_code,translate_name,original_name,self_code').in('item_code', codes);
      for (const c of (data ?? []) as CatNameRow[]) nameByCode.set(c.item_code, nameOf(c, c.item_code));
    })(),
    (async () => {
      if (!supplierIds.length) return;
      const { data } = await supabase.from('suppliers').select('supplier_id,name').in('supplier_id', supplierIds);
      for (const s of (data ?? []) as { supplier_id: number; name: string | null }[]) supplierById.set(s.supplier_id, s.name);
    })(),
  ]);

  let out: ReceivedItemRow[] = rows.map((r) => ({
    po_id: r.po_id,
    // uncatalogued codes (kept in item_code_raw by the reconcile) still show their code, not "(unnamed)"
    item_code: r.item_code ?? r.item_code_raw,
    name: r.item_code ? nameByCode.get(r.item_code) ?? r.item_code : r.item_code_raw ?? '(no SKU)',
    qty: r.qty,
    item_cost: r.item_cost,
    ship_id: r.ship_id,
    supplier_name: r.supplier_id != null ? supplierById.get(r.supplier_id) ?? null : null,
    receive_date: r.receive_date,
    marketplace_order_id: r.marketplace_order_id,
    product_link: r.product_link,
  }));

  const q = sanitize(query).toLowerCase();
  if (q) {
    out = out.filter(
      (r) =>
        (r.item_code ?? '').toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q) ||
        (r.ship_id ?? '').toLowerCase().includes(q)
    );
  }
  return out.slice(0, HISTORY_LIMIT);
}

// ── History → Per shipment (read-only): completed shipments, newest received first; one row per
// shipment with a count of its Received SKUs. Optional filter matches ship_id. (types in ./types) ──
export async function getShipmentHistory(query = ''): Promise<ShipmentHistoryRow[]> {
  const supabase = createSupabaseServerClient();
  const { data } = await supabase
    .from('shipments')
    .select('ship_id,forwarder_prefix,origin_country,ship_date,received_date,tracking,status')
    .not('received_date', 'is', null)
    .order('received_date', { ascending: false, nullsFirst: false })
    .limit(300);
  let ships = (data ?? []) as {
    ship_id: string; forwarder_prefix: string | null; origin_country: string | null;
    ship_date: string | null; received_date: string | null; tracking: string | null;
  }[];

  const q = sanitize(query).toLowerCase();
  if (q) ships = ships.filter((s) => s.ship_id.toLowerCase().includes(q));
  ships = ships.slice(0, HISTORY_LIMIT);
  if (!ships.length) return [];

  // roll-up the Received PO lines per ship_id: distinct SKUs, Σ cost, distinct supplier ids
  const shipIds = ships.map((s) => s.ship_id);
  const skusByShip = new Map<string, Set<string>>();
  const costByShip = new Map<string, number>();
  const supIdsByShip = new Map<string, Set<number>>();
  const allSupIds = new Set<number>();
  const { data: pos } = await supabase
    .from('purchase_orders')
    .select('ship_id,item_code,item_cost,supplier_id,status')
    .in('ship_id', shipIds)
    .eq('status', 'Received');
  for (const p of (pos ?? []) as { ship_id: string | null; item_code: string | null; item_cost: number | null; supplier_id: number | null }[]) {
    if (!p.ship_id) continue;
    if (p.item_code) (skusByShip.get(p.ship_id) ?? skusByShip.set(p.ship_id, new Set()).get(p.ship_id)!).add(p.item_code);
    if (p.item_cost != null) costByShip.set(p.ship_id, (costByShip.get(p.ship_id) ?? 0) + Number(p.item_cost));
    if (p.supplier_id != null) {
      (supIdsByShip.get(p.ship_id) ?? supIdsByShip.set(p.ship_id, new Set()).get(p.ship_id)!).add(p.supplier_id);
      allSupIds.add(p.supplier_id);
    }
  }

  // resolve supplier names once
  const supName = new Map<number, string>();
  if (allSupIds.size) {
    const { data: sup } = await supabase.from('suppliers').select('supplier_id,name').in('supplier_id', [...allSupIds]);
    for (const s of (sup ?? []) as { supplier_id: number; name: string | null }[]) supName.set(s.supplier_id, s.name ?? `#${s.supplier_id}`);
  }

  return ships.map((s) => ({
    ship_id: s.ship_id,
    forwarder_prefix: s.forwarder_prefix,
    origin_country: s.origin_country,
    ship_date: s.ship_date,
    received_date: s.received_date,
    tracking: s.tracking,
    item_count: skusByShip.get(s.ship_id)?.size ?? 0,
    total_cost: costByShip.has(s.ship_id) ? costByShip.get(s.ship_id)! : null,
    suppliers: [...(supIdsByShip.get(s.ship_id) ?? [])].map((id) => supName.get(id) ?? `#${id}`).sort(),
  }));
}
