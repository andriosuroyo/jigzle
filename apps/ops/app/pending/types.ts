// Shared types for the unified Orders section (PR27). Plain module (NO 'use server') so the actions
// file can export only async functions — the Vercel linux SWC requirement (same as the other types.ts).

// The order lifecycle, surfaced from orders.status + line fulfilled_at/shipped_at (PR27 does not
// invent a new status model). 'ready_to_ship' is DERIVED (≥1 fulfilled-unshipped line).
export type OrderState = 'need_payment' | 'need_send' | 'ready_to_ship' | 'complete';
export type OrderFilter = 'all' | OrderState;

// One row in the Orders board list.
export interface OrderRow {
  sales_id: string;
  customer_name: string | null;
  order_date: string | null;
  status: string | null;
  payment_status: string | null;
  sales_total_idr: number | null;
  paid_idr: number;
  balance: number;
  item_count: number;     // active (non-cancelled) lines
  state: OrderState;
}

// ── PR-B Pending screen (§3): orders with ≥1 uncut line, each line carrying live-ish availability ──
// Per-line readiness, from the stock_snapshot matview (RT-1, ≤5-min stale is fine for the dots):
//   available  = available ≥ qty
//   on_the_way = short, but available + on_the_way ≥ qty (incoming will cover it)
//   to_order   = short and even with incoming it won't cover (must order more)
export type LineStatus = 'available' | 'on_the_way' | 'to_order';
// Order dot = worst line: any to_order → red; else any on_the_way → yellow; else green.
export type OrderDot = 'red' | 'yellow' | 'green';

export interface PendingLine {
  line_id: string;
  item_code: string | null;
  name: string;
  qty: number;
  available: number;
  on_the_way: number;
  status: LineStatus;
  ready: boolean;          // available ≥ qty → eligible for "Send ready items"
}

export interface PendingOrder {
  sales_id: string;
  customer_name: string | null;
  order_date: string | null;
  payment_status: string | null;
  sales_total_idr: number | null;
  paid_idr: number;
  balance: number;
  dot: OrderDot;
  ready_count: number;     // how many uncut lines are ready (drives the "Send ready items" affordance)
  lines: PendingLine[];    // the order's UNCUT lines only
}

// mark_order_paid return.
export interface MarkPaidResult {
  payment_status: string;
  status: string;
  paid: number;
  balance: number;
}

// Complete-order read-only summary (kept minimal — header + shipped lines + boxes).
export interface ShippedLineSummary {
  line_id: string;
  item_code: string | null;
  name: string;
  qty: number;
  courier_label: string | null;
  courier_tracking: string | null;
}

export interface BoxSummary {
  box_id: number;
  real_weight: number | null;
  dim_p: number | null;
  dim_l: number | null;
  dim_t: number | null;
  chargeable_weight: number | null; // grams (PR26)
}

export interface OrderSummary {
  sales_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  status: string | null;
  payment_status: string | null;
  sales_total_idr: number | null;
  paid_idr: number;
  lines: ShippedLineSummary[];
  boxes: BoxSummary[];
}
