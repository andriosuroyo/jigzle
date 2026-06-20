'use server';

// Server actions for the Outbound (Ship) module (Sales pipeline step 5). Same auth posture as
// the sales/fulfill actions: the SSR supabase client (anon key + the signed-in user's session),
// so RLS (is_allowed_user()) gates every read and write. The service-role key is never used here.

import { createSupabaseServerClient } from '@jigzle/db/server';
import type { ShipLine, ShipQueueRow } from '@jigzle/db/types';
import type { ShipDetail, ShipInput, ShipResult } from './types';

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
    .select('sales_id,order_date,customer_id,customers(name,phone),order_lines!inner(line_id,courier)')
    .is('order_lines.shipped_at', null)
    .not('order_lines.fulfilled_at', 'is', null)
    .eq('order_lines.is_cancelled', false)
    .order('order_date', { ascending: false, nullsFirst: false })
    .limit(QUEUE_LIMIT);
  if (error || !data) return [];

  return data.map((o) => {
    const lines = (o.order_lines ?? []) as { line_id: string; courier: string | null }[];
    const cust = one<{ name: string | null; phone: string | null }>(o.customers as never);
    const planned = lines.find((l) => l.courier)?.courier ?? null;
    return {
      sales_id: o.sales_id as string,
      order_date: (o.order_date as string | null) ?? null,
      customer_name: cust?.name ?? null,
      customer_phone: cust?.phone ?? null,
      ready_count: lines.length,
      planned_courier: planned,
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
    .select('line_id,item_code,qty,courier,courier_label,courier_tracking,catalogue(original_name,translate_name,self_code)')
    .eq('sales_id', salesId)
    .not('fulfilled_at', 'is', null)
    .is('shipped_at', null)
    .eq('is_cancelled', false)
    .order('line_id');

  const rows = (lineRows ?? []) as unknown as {
    line_id: string;
    item_code: string | null;
    qty: number;
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
  const addressId = (order.address_id as number | null) ?? null;
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
