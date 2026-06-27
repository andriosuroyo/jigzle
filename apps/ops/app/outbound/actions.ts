'use server';

// Server actions for the Outbound (Ship) module (Sales pipeline step 5). Same auth posture as
// the sales/fulfill actions: the SSR supabase client (anon key + the signed-in user's session),
// so RLS (is_allowed_user()) gates every read and write. The service-role key is never used here.

import { createSupabaseServerClient } from '@jigzle/db/server';
import type { ShipLine, ShipQueueRow } from '@jigzle/db/types';
import type { ShipDetail, ShipInput, ShipResult, ShippedOrderRow } from './types';

const QUEUE_LIMIT = 100;

function one<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function skuName(
  c: { original_name: string | null; translate_name: string | null; self_code: string | null } | null,
  fallback: string
): string {
  if (!c) return fallback;
  return c.translate_name || c.original_name || c.self_code || fallback;
}

// ── the ready-to-ship worklist ──
export async function getShipQueue(): Promise<ShipQueueRow[]> {
  const supabase = createSupabaseServerClient();
  // orders that have ≥1 fulfilled-but-unshipped, non-cancelled line. The !inner embed + the
  // embedded filters restrict both which orders return and which lines come back.
  const { data, error } = await supabase
    .from('orders')
    .select('sales_id,order_date,customer_id,customers(name,phone),order_lines!inner(line_id,item_code,courier)')
    .is('order_lines.shipped_at', null)
    .not('order_lines.fulfilled_at', 'is', null)
    // PR-B §6: a line only ships once it's ADDRESSED (courier set in Fulfill). Without this, cut-but-
    // unaddressed lines (sitting in the Fulfill To-send queue) would wrongly appear here too.
    .not('order_lines.courier', 'is', null)
    .eq('order_lines.is_cancelled', false)
    .order('order_date', { ascending: false, nullsFirst: false })
    .limit(QUEUE_LIMIT);
  if (error || !data) return [];

  return data.map((o) => {
    const lines = (o.order_lines ?? []) as { line_id: string; item_code: string | null; courier: string | null }[];
    const cust = one<{ name: string | null; phone: string | null }>(o.customers as never);
    const planned = lines.find((l) => l.courier)?.courier ?? null;
    return {
      sales_id: o.sales_id as string,
      order_date: (o.order_date as string | null) ?? null,
      customer_name: cust?.name ?? null,
      customer_phone: cust?.phone ?? null,
      ready_count: lines.length,
      planned_courier: planned,
      sku_codes: lines.map((l) => l.item_code).filter((c): c is string => !!c),
    };
  });
}

// PostgREST .or()/.ilike() interpolate into a filter grammar — strip operator chars from user input.
function sanitize(q: string): string {
  return q.replace(/[,()*\\]/g, ' ').trim();
}

// ── Outbound History (orders we've shipped): orders with ≥1 shipped line, newest by ship date. Search
// matches sales_id OR customer name OR a shipped line's courier_tracking. Read-only. ──
export async function getShippedHistory(query = ''): Promise<ShippedOrderRow[]> {
  const supabase = createSupabaseServerClient();
  const raw = sanitize(query);

  // resolve customer-name / tracking matches to sales_ids first, so the main query can OR them in
  let orFilter: string | null = null;
  if (raw) {
    const ors = [`sales_id.ilike.%${raw}%`];
    const { data: custs } = await supabase.from('customers').select('customer_id').ilike('name', `%${raw}%`).limit(500);
    const ids = ((custs ?? []) as { customer_id: number }[]).map((c) => c.customer_id);
    if (ids.length) ors.push(`customer_id.in.(${ids.join(',')})`);
    const { data: trk } = await supabase
      .from('order_lines')
      .select('sales_id')
      .ilike('courier_tracking', `%${raw}%`)
      .not('shipped_at', 'is', null)
      .limit(500);
    const trkIds = [...new Set(((trk ?? []) as { sales_id: string }[]).map((t) => t.sales_id))];
    if (trkIds.length) ors.push(`sales_id.in.(${trkIds.map((s) => `"${s}"`).join(',')})`);
    orFilter = ors.join(',');
  }

  let q = supabase
    .from('orders')
    .select('sales_id,order_date,customer_id,customers(name),order_lines!inner(item_code,courier_label,courier_tracking,shipped_at)')
    .not('order_lines.shipped_at', 'is', null)
    .eq('order_lines.is_cancelled', false)
    .order('order_date', { ascending: false, nullsFirst: false })
    .limit(QUEUE_LIMIT);
  if (orFilter) q = q.or(orFilter);

  const { data, error } = await q;
  if (error || !data) return [];

  return data.map((o) => {
    const lines = (o.order_lines ?? []) as { item_code: string | null; courier_label: string | null; courier_tracking: string | null; shipped_at: string | null }[];
    const cust = one<{ name: string | null }>(o.customers as never);
    const shippedAts = lines.map((l) => l.shipped_at).filter((s): s is string => !!s).sort();
    return {
      sales_id: o.sales_id as string,
      order_date: (o.order_date as string | null) ?? null,
      customer_name: cust?.name ?? null,
      ship_date: shippedAts.length ? shippedAts[shippedAts.length - 1] : null,
      item_count: lines.length,
      sku_codes: lines.map((l) => l.item_code).filter((c): c is string => !!c),
      courier_label: lines.find((l) => l.courier_label)?.courier_label ?? null,
      courier_tracking: lines.find((l) => l.courier_tracking)?.courier_tracking ?? null,
    };
  });
}

// ── the ship detail pane ── (ShipDetail lives in ./types)
export async function getOrderForShip(salesId: string): Promise<ShipDetail | null> {
  const supabase = createSupabaseServerClient();

  const { data: order } = await supabase
    .from('orders')
    .select('sales_id,customer_id,address_id,status,customers(name,phone)')
    .eq('sales_id', salesId)
    .maybeSingle();
  if (!order) return null;

  const { data: lineRows } = await supabase
    .from('order_lines')
    .select('line_id,item_code,qty,address_id,courier,courier_label,courier_tracking,catalogue(original_name,translate_name,self_code)')
    .eq('sales_id', salesId)
    .not('fulfilled_at', 'is', null)
    // PR-B §6: only ADDRESSED lines belong to Outbound. A cut-but-unaddressed line (courier null, still
    // in Fulfill) on a straddling order must not be shipped here — match the getShipQueue predicate.
    .not('courier', 'is', null)
    .is('shipped_at', null)
    .eq('is_cancelled', false)
    .order('line_id');

  const rows = (lineRows ?? []) as unknown as {
    line_id: string;
    item_code: string | null;
    qty: number;
    address_id: number | null;
    courier: string | null;
    courier_label: string | null;
    courier_tracking: string | null;
    catalogue: { original_name: string | null; translate_name: string | null; self_code: string | null } | null;
  }[];

  const lines: ShipLine[] = rows.map((r) => ({
    line_id: r.line_id,
    item_code: r.item_code,
    name: skuName(one(r.catalogue as never), r.item_code ?? r.line_id),
    qty: r.qty,
    courier: r.courier,
  }));

  const codes = rows.map((r) => r.item_code).filter((c): c is string => !!c);

  // O3 address block: name/phone fall back to the customer; raw_address printed VERBATIM (never
  // rebuilt from the structured columns). courier_label/tracking come off the line (stamped at fulfill).
  let recipientName: string | null = null;
  let contactPhone: string | null = null;
  let rawAddress: string | null = null;
  let shipAddress: string | null = null; // legacy single-line fallback (kept for compatibility)
  // PR-B: the address Fulfill confirmed is stamped on the LINE by set_fulfillment (orders.address_id
  // may be null when SA-1 deferred it). Prefer the line's address; fall back to the order's.
  const addressId = (rows.find((r) => r.address_id != null)?.address_id ?? (order.address_id as number | null)) ?? null;
  if (addressId != null) {
    const { data: a } = await supabase
      .from('customer_addresses')
      .select('raw_address,recipient_name,contact_phone,kota')
      .eq('address_id', addressId)
      .maybeSingle();
    if (a) {
      rawAddress = a.raw_address ?? null;
      recipientName = a.recipient_name ?? null;
      contactPhone = a.contact_phone ?? null;
      shipAddress = a.raw_address || [a.recipient_name, a.kota].filter(Boolean).join(', ') || null;
    }
  }
  const courierLabel = rows.find((r) => r.courier_label)?.courier_label ?? null;
  const courierTracking = rows.find((r) => r.courier_tracking)?.courier_tracking ?? null;

  // barcodes for optional scan resolution
  let barcodes: { barcode: string; item_code: string }[] = [];
  if (codes.length) {
    const { data: bc } = await supabase.from('barcodes').select('barcode,item_code').in('item_code', codes);
    barcodes = (bc ?? []) as { barcode: string; item_code: string }[];
  }

  // how many unshipped, non-cancelled lines are NOT yet fulfilled (→ order can't be Complete yet)
  const { count: pending } = await supabase
    .from('order_lines')
    .select('line_id', { count: 'exact', head: true })
    .eq('sales_id', salesId)
    .is('shipped_at', null)
    .eq('is_cancelled', false)
    .is('fulfilled_at', null);

  const cust = one<{ name: string | null; phone: string | null }>(order.customers as never);
  return {
    sales_id: order.sales_id as string,
    customer_id: (order.customer_id as number | null) ?? null,
    customer_name: cust?.name ?? null,
    customer_phone: cust?.phone ?? null,
    status: (order.status as string | null) ?? null,
    address_id: addressId,
    ship_address: shipAddress,
    recipient_name: recipientName,
    contact_phone: contactPhone,
    raw_address: rawAddress,
    planned_courier: lines.find((l) => l.courier)?.courier ?? null,
    courier_label: courierLabel,
    courier_tracking: courierTracking,
    lines,
    barcodes,
    pending_fulfill_count: pending ?? 0,
  };
}

// ── commit the shipment ── (BoxInput / ShipInput / ShipResult live in ./types)
export async function recordShipment(payload: ShipInput): Promise<ShipResult> {
  if (!payload.line_ids?.length) throw new Error('recordShipment: select at least one line');
  const supabase = createSupabaseServerClient();

  // O4: courier/tracking are set at Fulfill and travel on the line — Outbound never re-sends them.
  // The RPC COALESCEs these nulls, preserving the fulfill-stamped values.
  const { data, error } = await supabase.rpc('record_shipment', {
    p_sales_id: payload.sales_id,
    p_line_ids: payload.line_ids,
    p_courier: null,
    p_tracking: null,
    p_boxes: payload.boxes ?? [],
  });
  if (error) throw new Error(`recordShipment: ${error.message}`);

  const affected = (data as string[] | null) ?? [];
  let stock: ShipResult['stock'] = [];
  if (affected.length) {
    const { data: s } = await supabase
      .from('stock_check')
      .select('item_code,available,physical,reserved')
      .in('item_code', affected);
    stock = (s ?? []) as ShipResult['stock'];
  }
  return { affected, stock };
}

// ── Return to Fulfill (PR-B §6): clear the courier on the order's cut-unshipped lines via
// set_fulfillment (PR-A) — the cut + address stay, so the order drops back into the Fulfill To-send
// queue (NOT all the way to Pending; that's Fulfill's "send back to pending"). No stock movement. ──
export async function returnToFulfill(salesId: string): Promise<void> {
  if (!salesId) throw new Error('returnToFulfill: sales_id is required');
  const supabase = createSupabaseServerClient();

  // the ADDRESSED (courier-set), unshipped, non-cancelled lines Outbound is holding — same predicate
  // as getShipQueue/getOrderForShip, so a straddling order's still-in-Fulfill lines aren't touched.
  const { data: lineRows } = await supabase
    .from('order_lines')
    .select('line_id,courier_tracking')
    .eq('sales_id', salesId)
    .not('fulfilled_at', 'is', null)
    .not('courier', 'is', null)
    .is('shipped_at', null)
    .eq('is_cancelled', false);
  const rows = (lineRows ?? []) as { line_id: string; courier_tracking: string | null }[];
  const lineIds = rows.map((r) => r.line_id);
  if (!lineIds.length) return; // nothing addressed to return

  // p_courier/speed/label = null → cleared; p_address_id = null → coalesce keeps the address. KEEP the
  // tracking (set_fulfillment sets it to the value passed) so it survives the round-trip and Fulfill can
  // re-prefill it — re-picking the courier shouldn't make the operator re-type the resi.
  const tracking = rows.find((r) => r.courier_tracking)?.courier_tracking ?? null;
  const { error } = await supabase.rpc('set_fulfillment', {
    p_sales_id: salesId,
    p_line_ids: lineIds,
    p_address_id: null,
    p_courier: null,
    p_tracking: tracking,
    p_courier_speed: null,
    p_courier_label: null,
  });
  if (error) throw new Error(`returnToFulfill: ${error.message}`);
}
