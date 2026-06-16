'use server';

// Server actions for the Fulfill module (Sales pipeline step 4). Same auth posture as the
// sales actions: the SSR supabase client (anon key + the signed-in user's session), so RLS
// (is_allowed_user()) gates every read and write. The service-role key is never used here.

import { createSupabaseServerClient } from '@jigzle/db/server';
import type {
  CustomerAddress,
  FulfillLine,
  FulfillQueueRow,
  Hold,
  PaymentStatus,
} from '@jigzle/db/types';

// Most-recent N 'Need send' orders with unfulfilled lines. The queue is timestamp-derived
// (D1), so there is no status to page on; cap the worklist and order by recency.
const QUEUE_LIMIT = 100;

// Embedded to-one resources come back as an object (or, depending on cardinality detection,
// a 1-element array). Normalize so callers can treat it as a single row or null.
function one<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function skuName(c: { original_name: string | null; translate_name: string | null; self_code: string | null } | null, fallback: string): string {
  if (!c) return fallback;
  return c.translate_name || c.original_name || c.self_code || fallback;
}

// ── live available for a set of item_codes ──
async function availabilityFor(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  itemCodes: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const codes = [...new Set(itemCodes)];
  if (!codes.length) return out;
  const { data } = await supabase.from('stock_check').select('item_code,available').in('item_code', codes);
  for (const r of data ?? []) out.set(r.item_code as string, r.available as number);
  return out;
}

// ── the worklist ──
export async function getFulfillQueue(filterReadyOnly = false): Promise<FulfillQueueRow[]> {
  const supabase = createSupabaseServerClient();
  // orders in 'Need send' that have ≥1 unfulfilled, non-cancelled line. The !inner embed +
  // the embedded filters restrict both which orders return and which lines come back.
  const { data, error } = await supabase
    .from('orders')
    .select('sales_id,order_date,payment_status,customer_id,customers(name,phone),order_lines!inner(line_id,item_code,qty)')
    .eq('status', 'Need send')
    .is('order_lines.fulfilled_at', null)
    .eq('order_lines.is_cancelled', false)
    .order('order_date', { ascending: false, nullsFirst: false })
    .limit(QUEUE_LIMIT);
  if (error || !data) return [];

  const allCodes: string[] = [];
  for (const o of data) {
    for (const l of (o.order_lines ?? []) as { item_code: string | null }[]) {
      if (l.item_code) allCodes.push(l.item_code);
    }
  }
  const avail = await availabilityFor(supabase, allCodes);

  const rows: FulfillQueueRow[] = data.map((o) => {
    const lines = (o.order_lines ?? []) as { line_id: string; item_code: string | null; qty: number }[];
    const cust = one<{ name: string | null; phone: string | null }>(o.customers as never);
    const shortCount = lines.filter((l) => (avail.get(l.item_code ?? '') ?? 0) < l.qty).length;
    return {
      sales_id: o.sales_id as string,
      order_date: (o.order_date as string | null) ?? null,
      customer_name: cust?.name ?? null,
      customer_phone: cust?.phone ?? null,
      payment_status: (o.payment_status as PaymentStatus | null) ?? null,
      line_count: lines.length,
      short_count: shortCount,
      ready: shortCount === 0,
    };
  });
  return filterReadyOnly ? rows.filter((r) => r.ready) : rows;
}

// ── the detail pane ──
export interface FulfillDetail {
  sales_id: string;
  customer_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  payment_status: PaymentStatus | null;
  default_address_id: number | null; // the order's current address_id
  lines: FulfillLine[];
  addresses: CustomerAddress[];
  holds: Hold[]; // active holds matching a line's item_code (and this customer / customer-agnostic)
}

export async function getOrderForFulfill(salesId: string): Promise<FulfillDetail | null> {
  const supabase = createSupabaseServerClient();

  const { data: order } = await supabase
    .from('orders')
    .select('sales_id,customer_id,address_id,payment_status,customers(name,phone)')
    .eq('sales_id', salesId)
    .maybeSingle();
  if (!order) return null;

  const { data: lineRows } = await supabase
    .from('order_lines')
    .select('line_id,item_code,qty,catalogue(original_name,translate_name,self_code)')
    .eq('sales_id', salesId)
    .is('fulfilled_at', null)
    .eq('is_cancelled', false)
    .order('line_id');

  // supabase-js types the to-one `catalogue` embed as an array; one() normalizes it at
  // runtime, so cast through unknown to the to-one shape the rest of this code expects.
  const rows = (lineRows ?? []) as unknown as {
    line_id: string;
    item_code: string | null;
    qty: number;
    catalogue: { original_name: string | null; translate_name: string | null; self_code: string | null } | null;
  }[];

  const codes = rows.map((r) => r.item_code).filter((c): c is string => !!c);
  const avail = await availabilityFor(supabase, codes);

  const lines: FulfillLine[] = rows.map((r) => ({
    line_id: r.line_id,
    item_code: r.item_code,
    name: skuName(one(r.catalogue as never), r.item_code ?? r.line_id),
    qty: r.qty,
    available: avail.get(r.item_code ?? '') ?? 0,
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

  // Matching active holds: same item_code, and the hold is customer-agnostic OR names this
  // order's customer (mirrors the RPC's release predicate).
  let holds: Hold[] = [];
  if (codes.length) {
    const { data: hs } = await supabase
      .from('holds')
      .select('*')
      .in('item_code', codes)
      .is('released_at', null);
    holds = ((hs ?? []) as Hold[]).filter((h) => h.customer_id == null || h.customer_id === customerId);
  }

  const cust = one<{ name: string | null; phone: string | null }>(order.customers as never);
  return {
    sales_id: order.sales_id as string,
    customer_id: customerId,
    customer_name: cust?.name ?? null,
    customer_phone: cust?.phone ?? null,
    payment_status: (order.payment_status as PaymentStatus | null) ?? null,
    default_address_id: (order.address_id as number | null) ?? null,
    lines,
    addresses,
    holds,
  };
}

// ── commit the stock cut ──
export interface FulfillInput {
  sales_id: string;
  line_ids: string[];
  address_id: number;
  courier: string | null;
  tracking?: string | null;
}

export interface FulfillResult {
  affected: string[]; // item_codes whose stock moved
  stock: { item_code: string; available: number; reserved: number; physical: number }[];
}

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
