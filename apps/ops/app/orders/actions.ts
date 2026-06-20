'use server';

// Server actions for the unified Orders section (PR27). Same auth posture as the other modules: the
// SSR supabase client (anon key + the signed-in user's session), so RLS (is_allowed_user()) gates
// every read and write. The service-role key is never used here.

import { createSupabaseServerClient } from '@jigzle/db/server';
import type {
  BoxSummary,
  MarkPaidResult,
  OrderFilter,
  OrderRow,
  OrderState,
  OrderSummary,
  ShippedLineSummary,
} from './types';

const LIMIT = 200;

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

type LineLite = { fulfilled_at: string | null; shipped_at: string | null; is_cancelled: boolean };

// derive an order's primary state from its status + line progress (same signals the Fulfill/Outbound
// queues use). Need payment gates first; Complete is terminal; otherwise ready-to-ship (something to
// ship now) outranks need-send.
function deriveState(status: string | null, lines: LineLite[]): OrderState {
  if (status === 'Need payment') return 'need_payment';
  if (status === 'Complete') return 'complete';
  const active = lines.filter((l) => !l.is_cancelled);
  if (active.some((l) => l.fulfilled_at && !l.shipped_at)) return 'ready_to_ship';
  return 'need_send';
}

// ── the board list, filtered by state ──
export async function getOrders(filter: OrderFilter = 'all'): Promise<OrderRow[]> {
  const supabase = createSupabaseServerClient();
  let q = supabase
    .from('orders')
    .select('sales_id,order_date,status,payment_status,sales_total_idr,paid_idr,customer_id,customers(name),order_lines(line_id,fulfilled_at,shipped_at,is_cancelled)')
    // Cancelled orders are out of this board's lifecycle (no Cancelled tab) — exclude them so they
    // never fall through deriveState() to a wrong "Need send" badge + dead Fulfill link.
    .neq('status', 'Cancelled')
    .order('order_date', { ascending: false, nullsFirst: false })
    .limit(LIMIT);

  // coarse status pre-filter where it maps 1:1 (need_send + ready_to_ship both live under 'Need send'
  // and are split by line flags below).
  if (filter === 'need_payment') q = q.eq('status', 'Need payment');
  else if (filter === 'complete') q = q.eq('status', 'Complete');
  else if (filter === 'need_send' || filter === 'ready_to_ship') q = q.eq('status', 'Need send');

  const { data, error } = await q;
  if (error || !data) return [];

  const rows: OrderRow[] = data.map((o) => {
    const lines = (o.order_lines ?? []) as LineLite[];
    const active = lines.filter((l) => !l.is_cancelled);
    const cust = one<{ name: string | null }>(o.customers as never);
    const total = (o.sales_total_idr as number | null) ?? null;
    const paid = (o.paid_idr as number | null) ?? 0;
    return {
      sales_id: o.sales_id as string,
      customer_name: cust?.name ?? null,
      order_date: (o.order_date as string | null) ?? null,
      status: (o.status as string | null) ?? null,
      payment_status: (o.payment_status as string | null) ?? null,
      sales_total_idr: total,
      paid_idr: paid,
      balance: Math.max((total ?? 0) - paid, 0),
      item_count: active.length,
      state: deriveState(o.status as string | null, lines),
    };
  });

  if (filter === 'all') return rows;
  return rows.filter((r) => r.state === filter);
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
