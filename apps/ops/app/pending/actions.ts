'use server';

// Server actions for the Pending screen (PR-B §3) + the order summary / mark-paid helpers shared with
// History. Same auth posture as the other modules: the SSR supabase client (anon key + the signed-in
// user's session), so RLS (is_allowed_user()) gates every read and write. The service-role key is
// never used here.
//   getOrderSummary + markOrderPaid are PR27 carry-overs re-used by History (§4); the Pending board
//   itself reads getPending + sendReadyItems + deletePendingOrder.

import { createSupabaseServerClient } from '@jigzle/db/server';
import type {
  BoxSummary,
  LineStatus,
  MarkPaidResult,
  OrderDot,
  OrderSummary,
  PendingLine,
  PendingOrder,
  ShippedLineSummary,
} from './types';

function one<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function nameOf(
  c: { original_name: string | null; translate_name: string | null; self_code: string | null } | null,
  fallback: string
): string {
  if (!c) return fallback;
  return c.translate_name || c.original_name || c.self_code || fallback;
}

const PENDING_LIMIT = 200;

// per-line readiness from available / on_the_way vs qty (FP-2/FP-3). An uncoded line carries no stock
// gate → always 'available' / ready (a custom item the operator handles manually).
function lineStatus(coded: boolean, available: number, onTheWay: number, qty: number): LineStatus {
  if (!coded) return 'available';
  if (available >= qty) return 'available';
  if (available + onTheWay >= qty) return 'on_the_way';
  return 'to_order';
}

// ── Pending queue (§3): orders with ≥1 UNCUT, non-cancelled, unshipped line, each line carrying its
// availability from the stock_snapshot matview (RT-1). Cancelled orders excluded; newest first. ──
export async function getPending(): Promise<PendingOrder[]> {
  const supabase = createSupabaseServerClient();
  // !inner + embedded filters restrict BOTH which orders return AND which lines come back to the
  // order's uncut lines only (a partial order's already-cut lines live in Fulfill/Outbound, not here).
  const { data, error } = await supabase
    .from('orders')
    .select('sales_id,order_date,status,payment_status,sales_total_idr,paid_idr,customers(name),order_lines!inner(line_id,item_code,qty,catalogue(original_name,translate_name,self_code))')
    .neq('status', 'Cancelled')
    .is('order_lines.fulfilled_at', null)
    .is('order_lines.shipped_at', null)
    .eq('order_lines.is_cancelled', false)
    .order('order_date', { ascending: false, nullsFirst: false })
    .limit(PENDING_LIMIT);
  if (error || !data) return [];

  // availability for every coded line, from the matview (absent SKU → 0 avail / 0 on_the_way)
  const codes: string[] = [];
  for (const o of data)
    for (const l of (o.order_lines ?? []) as { item_code: string | null }[]) if (l.item_code) codes.push(l.item_code);
  const availByCode = new Map<string, { available: number; on_the_way: number }>();
  if (codes.length) {
    const { data: snap } = await supabase
      .from('stock_snapshot')
      .select('item_code,available,on_the_way')
      .in('item_code', [...new Set(codes)]);
    for (const r of snap ?? [])
      availByCode.set(r.item_code as string, {
        available: (r.available as number) ?? 0,
        on_the_way: (r.on_the_way as number) ?? 0,
      });
  }

  const out: PendingOrder[] = data.map((o) => {
    const lineRows = (o.order_lines ?? []) as unknown as {
      line_id: string;
      item_code: string | null;
      qty: number;
      catalogue: { original_name: string | null; translate_name: string | null; self_code: string | null } | null;
    }[];
    const lines: PendingLine[] = lineRows.map((r) => {
      const a = availByCode.get(r.item_code ?? '') ?? { available: 0, on_the_way: 0 };
      const status = lineStatus(!!r.item_code, a.available, a.on_the_way, r.qty);
      return {
        line_id: r.line_id,
        item_code: r.item_code,
        name: nameOf(one(r.catalogue as never), r.item_code ?? r.line_id),
        qty: r.qty,
        available: a.available,
        on_the_way: a.on_the_way,
        status,
        ready: status === 'available',
      };
    });
    // dot = worst line: any to_order → red; else any on_the_way → yellow; else green
    const dot: OrderDot = lines.some((l) => l.status === 'to_order')
      ? 'red'
      : lines.some((l) => l.status === 'on_the_way')
        ? 'yellow'
        : 'green';
    const cust = one<{ name: string | null }>(o.customers as never);
    const total = (o.sales_total_idr as number | null) ?? null;
    const paid = (o.paid_idr as number | null) ?? 0;
    return {
      sales_id: o.sales_id as string,
      customer_name: cust?.name ?? null,
      order_date: (o.order_date as string | null) ?? null,
      payment_status: (o.payment_status as string | null) ?? null,
      sales_total_idr: total,
      paid_idr: paid,
      balance: Math.max((total ?? 0) - paid, 0),
      dot,
      ready_count: lines.filter((l) => l.ready).length,
      lines,
    };
  });
  return out;
}

// ── Send ready items (FP-6): cut the selected ready line_ids (cut_order_lines, PR-A). No payment gate
// (D5). Short lines stay in Pending; the cut lines move to Fulfill. Returns affected item_codes. ──
export async function sendReadyItems(salesId: string, lineIds: string[]): Promise<string[]> {
  if (!lineIds?.length) throw new Error('sendReadyItems: select at least one ready line');
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('cut_order_lines', { p_sales_id: salesId, p_line_ids: lineIds });
  if (error) throw new Error(`sendReadyItems: ${error.message}`);
  return (data as string[] | null) ?? [];
}

// ── Delete pending (FP-4): hard delete a FULLY-uncut order (delete_pending_order, 0033). The RPC's
// guard refuses if any line is cut/shipped; cascades payments + lines + order in one transaction. ──
export async function deletePendingOrder(salesId: string): Promise<void> {
  if (!salesId) throw new Error('deletePendingOrder: sales_id is required');
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('delete_pending_order', { p_sales_id: salesId });
  if (error) throw new Error(`deletePendingOrder: ${error.message}`);
}

// ── mark a Need-payment order paid (records the payment, recomputes status) ──
export async function markOrderPaid(salesId: string, amount: number, method: string | null): Promise<MarkPaidResult> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('mark_order_paid', {
    p_sales_id: salesId,
    p_amount: Math.round(amount),
    p_method: method,
  });
  if (error) throw new Error(`markOrderPaid: ${error.message}`);
  return data as MarkPaidResult;
}

// ── read-only summary for a Complete order (header + shipped lines + boxes) ──
export async function getOrderSummary(salesId: string): Promise<OrderSummary | null> {
  const supabase = createSupabaseServerClient();

  const { data: order } = await supabase
    .from('orders')
    .select('sales_id,status,payment_status,sales_total_idr,paid_idr,customers(name,phone)')
    .eq('sales_id', salesId)
    .maybeSingle();
  if (!order) return null;

  const { data: lineRows } = await supabase
    .from('order_lines')
    .select('line_id,item_code,qty,courier_label,courier_tracking,catalogue(original_name,translate_name,self_code)')
    .eq('sales_id', salesId)
    .not('shipped_at', 'is', null)
    .eq('is_cancelled', false)
    .order('line_id');

  const lr = (lineRows ?? []) as unknown as {
    line_id: string;
    item_code: string | null;
    qty: number;
    courier_label: string | null;
    courier_tracking: string | null;
    catalogue: { original_name: string | null; translate_name: string | null; self_code: string | null } | null;
  }[];
  const lines: ShippedLineSummary[] = lr.map((r) => ({
    line_id: r.line_id,
    item_code: r.item_code,
    name: nameOf(one(r.catalogue as never), r.item_code ?? r.line_id),
    qty: r.qty,
    courier_label: r.courier_label,
    courier_tracking: r.courier_tracking,
  }));

  // boxes group by send_id; outbound_shipments links sales_id → send_id.
  let boxes: BoxSummary[] = [];
  const { data: shp } = await supabase
    .from('outbound_shipments')
    .select('send_id')
    .eq('sales_id', salesId)
    .not('send_id', 'is', null);
  const sendIds = [...new Set(((shp ?? []) as { send_id: string | null }[]).map((s) => s.send_id).filter((s): s is string => !!s))];
  if (sendIds.length) {
    const { data: bx } = await supabase
      .from('boxes')
      .select('box_id,real_weight,dim_p,dim_l,dim_t,chargeable_weight')
      .in('send_id', sendIds)
      .order('box_id');
    boxes = (bx ?? []) as BoxSummary[];
  }

  const cust = one<{ name: string | null; phone: string | null }>(order.customers as never);
  return {
    sales_id: order.sales_id as string,
    customer_name: cust?.name ?? null,
    customer_phone: cust?.phone ?? null,
    status: (order.status as string | null) ?? null,
    payment_status: (order.payment_status as string | null) ?? null,
    sales_total_idr: (order.sales_total_idr as number | null) ?? null,
    paid_idr: (order.paid_idr as number | null) ?? 0,
    lines,
    boxes,
  };
}
