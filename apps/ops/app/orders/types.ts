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
