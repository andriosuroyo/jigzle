'use server';

// Server actions for the Procurement module (the buying pipeline BEFORE Receiving). Same auth
// posture as the sales/fulfill/outbound/receiving actions: the SSR supabase client (anon key +
// the signed-in user's session), so RLS (is_allowed_user()) gates every read and write. The
// service-role key is never used here (the smoke harness uses it as a TEST harness only).
//
// PO / supplier / forwarder writes are single-table, direct RLS-gated writes; only shipment
// grouping (multi-row + the shipments upsert) goes through the group_pos_into_shipment RPC (0018).

import { createSupabaseServerClient } from '@jigzle/db/server';
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
  NewSupplierInput,
  OpenPOFilter,
  OpenShipmentRow,
  SkuHit,
  UpdatePOPatch,
} from './types';

const QUEUE_LIMIT = 200;

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
      'po_id,item_code,item_code_raw,qty,status,status_since,ship_id,supplier_id,item_cost,method,marketplace_order_id,customer_id,item_note,shipment_note'
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
      const { data: cus } = await supabase.from('customers').select('customer_id,name').in('customer_id', customerIds);
      for (const c of (cus ?? []) as { customer_id: number; name: string | null }[]) customerById.set(c.customer_id, c.name);
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
    shipment_note: r.shipment_note,
  }));
}

// ── supplier / forwarder / open-shipment lists for the form dropdowns ──
export async function getSuppliers(): Promise<Supplier[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('suppliers')
    .select('supplier_id,name,country,flag,type,created_at')
    .order('name', { ascending: true });
  if (error || !data) return [];
  return data as Supplier[];
}

export async function getForwarders(): Promise<Forwarder[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('forwarders')
    .select('prefix,name,country,created_at')
    .order('prefix', { ascending: true });
  if (error || !data) return [];
  return data as Forwarder[];
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

// ── SKU search (catalogue text + barcode), with live available + incoming (D3) ── (SkuHit in ./types)
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

  const { data: stock } = await supabase
    .from('stock_check')
    .select('item_code,available,pending,on_the_way')
    .in('item_code', codes);
  const sm = new Map(
    ((stock ?? []) as { item_code: string; available: number; pending: number; on_the_way: number }[]).map((s) => [s.item_code, s])
  );

  return codes.map((item_code) => {
    const s = sm.get(item_code);
    return {
      item_code,
      name: named.get(item_code)!,
      available: s?.available ?? 0,
      pending: s?.pending ?? 0,
      on_the_way: s?.on_the_way ?? 0,
    };
  });
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

// ── inline "+ add" supplier (idempotent on the unique name) ──
export async function addSupplier(input: NewSupplierInput): Promise<Supplier> {
  const supabase = createSupabaseServerClient();
  const name = input.name?.trim();
  if (!name) throw new Error('addSupplier: a name is required');

  const { data: existing } = await supabase.from('suppliers').select('*').eq('name', name).maybeSingle();
  if (existing) return existing as Supplier;

  const { data, error } = await supabase
    .from('suppliers')
    .insert({
      name,
      country: input.country?.trim() || null,
      flag: input.flag?.trim() || null,
      type: input.type ?? null,
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

// ── inline "+ add" forwarder (idempotent on the prefix PK) ──
export async function addForwarder(input: NewForwarderInput): Promise<Forwarder> {
  const supabase = createSupabaseServerClient();
  const prefix = input.prefix?.trim();
  if (!prefix) throw new Error('addForwarder: a prefix is required');

  const { data: existing } = await supabase.from('forwarders').select('*').eq('prefix', prefix).maybeSingle();
  if (existing) return existing as Forwarder;

  const { data, error } = await supabase
    .from('forwarders')
    .insert({ prefix, name: input.name?.trim() || null, country: input.country?.trim() || null })
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
