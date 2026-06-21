'use server';

// Server actions for the Fulfill module (Sales pipeline step 4). Same auth posture as the
// sales actions: the SSR supabase client (anon key + the signed-in user's session), so RLS
// (is_allowed_user()) gates every read and write. The service-role key is never used here.

import { createSupabaseServerClient } from '@jigzle/db/server';
import type { CustomerAddress } from '@jigzle/db/types';
import type {
  FulfillCutLine,
  FulfillDetail,
  FulfillInput,
  FulfillResult,
  SendToOutboundInput,
  ToSendQueueRow,
} from './types';

// Most-recent N 'Need send' orders with unfulfilled lines. The queue is timestamp-derived
// (D1), so there is no status to page on; cap the worklist and order by recency.
const QUEUE_LIMIT = 100;

// Embedded to-one resources come back as an object (or, depending on cardinality detection,
// a 1-element array). Normalize so callers can treat it as a single row or null.
function one<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function catName(c: { original_name: string | null; translate_name: string | null; self_code: string | null } | null): string | null {
  if (!c) return null;
  return c.translate_name || c.original_name || c.self_code || null;
}

// F4: a coded line with no catalogue name falls back to line_note → item_link host/slug → the literal
// "Unmatched item". NEVER the raw line_id.
function fallbackName(lineNote: string | null, itemLink: string | null): string {
  const note = lineNote?.trim();
  if (note) return note;
  const link = linkLabel(itemLink);
  if (link) return link;
  return 'Unmatched item';
}

function linkLabel(link: string | null): string | null {
  const s = link?.trim();
  if (!s) return null;
  try {
    const u = new URL(s.includes('://') ? s : `https://${s}`);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg ? `${u.hostname}/${seg}` : u.hostname;
  } catch {
    return s; // not a parseable URL — show the raw link text
  }
}

// ── the detail pane (FT-6: read-only cut lines + addresses; NO holds / availability / checkbox — the
// cut + hold-release already happened upstream; Fulfill only confirms address + courier) ──
export async function getOrderForFulfill(salesId: string): Promise<FulfillDetail | null> {
  const supabase = createSupabaseServerClient();

  const { data: order } = await supabase
    .from('orders')
    .select('sales_id,order_date,customer_id,address_id,customers(name,phone)')
    .eq('sales_id', salesId)
    .maybeSingle();
  if (!order) return null;

  // the cut, not-yet-addressed (courier null), unshipped lines — the set Fulfill addresses + sends out
  const { data: lineRows } = await supabase
    .from('order_lines')
    .select('line_id,item_code,qty,line_note,item_link,catalogue(original_name,translate_name,self_code)')
    .eq('sales_id', salesId)
    .not('fulfilled_at', 'is', null)
    .is('courier', null)
    .is('shipped_at', null)
    .eq('is_cancelled', false)
    .order('line_id');

  // supabase-js types the to-one `catalogue` embed as an array; one() normalizes it at runtime.
  const rows = (lineRows ?? []) as unknown as {
    line_id: string;
    item_code: string | null;
    qty: number;
    line_note: string | null;
    item_link: string | null;
    catalogue: { original_name: string | null; translate_name: string | null; self_code: string | null } | null;
  }[];

  const lines: FulfillCutLine[] = rows.map((r) => ({
    line_id: r.line_id,
    item_code: r.item_code,
    // F4: catalogue name if matched, else line_note → item_link → "Unmatched item" (never line_id)
    name: catName(one(r.catalogue as never)) || fallbackName(r.line_note, r.item_link),
    qty: r.qty,
  }));

  const customerId = (order.customer_id as number | null) ?? null;
  let addresses: CustomerAddress[] = [];
  if (customerId != null) {
    const { data: addrs } = await supabase
      .from('customer_addresses')
      .select('*')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false });
    addresses = (addrs ?? []) as CustomerAddress[];
  }

  const cust = one<{ name: string | null; phone: string | null }>(order.customers as never);
  const addressId = (order.address_id as number | null) ?? null;
  return {
    sales_id: order.sales_id as string,
    order_date: (order.order_date as string | null) ?? null,
    customer_name: cust?.name ?? null,
    customer_phone: cust?.phone ?? null,
    default_address_id: addressId,
    needs_address: addressId == null,
    lines,
    addresses,
  };
}

// ── commit the stock cut ── (FulfillInput / FulfillResult live in ./types)
export async function fulfillOrder(payload: FulfillInput): Promise<FulfillResult> {
  if (!payload.line_ids?.length) throw new Error('fulfillOrder: select at least one line');
  if (!payload.address_id) throw new Error('fulfillOrder: an address is required');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('fulfill_order', {
    p_sales_id: payload.sales_id,
    p_line_ids: payload.line_ids,
    p_address_id: payload.address_id,
    p_courier: payload.courier ?? null,
    p_tracking: payload.tracking ?? null,
    p_courier_speed: payload.courier_speed ?? null,
    p_courier_label: payload.courier_label ?? null,
  });
  if (error) throw new Error(`fulfillOrder: ${error.message}`);

  const affected = (data as string[] | null) ?? [];
  let stock: FulfillResult['stock'] = [];
  if (affected.length) {
    const { data: s } = await supabase
      .from('stock_check')
      .select('item_code,available,reserved,physical')
      .in('item_code', affected);
    stock = (s ?? []) as FulfillResult['stock'];
  }
  return { affected, stock };
}

// ── PR-B "To send" queue (FT-2/FT-3): orders with cut + courier-null + unshipped lines. The !inner
// embed + embedded filters restrict both which orders return AND which lines come back (only the cut,
// not-yet-addressed lines — a partial order's already-shipped or still-uncut lines are elsewhere). ──
export async function getToSendQueue(): Promise<ToSendQueueRow[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('orders')
    .select('sales_id,order_date,customer_id,customers(name),order_lines!inner(line_id,item_code)')
    .not('order_lines.fulfilled_at', 'is', null)
    .is('order_lines.courier', null)
    .is('order_lines.shipped_at', null)
    .eq('order_lines.is_cancelled', false)
    .order('order_date', { ascending: false, nullsFirst: false })
    .limit(QUEUE_LIMIT);
  if (error || !data) return [];

  return data.map((o) => {
    const lines = (o.order_lines ?? []) as { line_id: string; item_code: string | null }[];
    const cust = one<{ name: string | null }>(o.customers as never);
    return {
      sales_id: o.sales_id as string,
      order_date: (o.order_date as string | null) ?? null,
      customer_name: cust?.name ?? null,
      item_count: lines.length,
      sku_codes: lines.map((l) => l.item_code).filter((c): c is string => !!c),
    };
  });
}

// ── Send to Outbound (FT-6): set courier + (deferred) address on the cut lines via set_fulfillment
// (PR-A). No stock movement. Server-validates the Outbound gate: address + courier both present. ──
export async function sendToOutbound(input: SendToOutboundInput): Promise<void> {
  if (!input.line_ids?.length) throw new Error('sendToOutbound: no cut lines to send');
  if (!input.address_id) throw new Error('sendToOutbound: an address is required');
  if (!input.courier) throw new Error('sendToOutbound: a courier is required');
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('set_fulfillment', {
    p_sales_id: input.sales_id,
    p_line_ids: input.line_ids,
    p_address_id: input.address_id,
    p_courier: input.courier,
    p_tracking: input.tracking ?? null,
    p_courier_speed: input.courier_speed ?? null,
    p_courier_label: input.courier_label ?? null,
  });
  if (error) throw new Error(`sendToOutbound: ${error.message}`);
}

// ── Send back to pending (FT-4): clear the cut entirely (unfulfill_order) → the lines return to
// Pending uncut, stock restored. Inverse of the cut; holds + payment untouched. ──
export async function sendBackToPending(salesId: string): Promise<void> {
  if (!salesId) throw new Error('sendBackToPending: sales_id is required');
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('unfulfill_order', { p_sales_id: salesId });
  if (error) throw new Error(`sendBackToPending: ${error.message}`);
}
