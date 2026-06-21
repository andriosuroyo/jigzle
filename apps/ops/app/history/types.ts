// Shared types for the History screen (PR-B §4). Plain module (NO 'use server') so the actions file
// exports only async functions (the Vercel linux SWC requirement). History shows ALL orders including
// Cancelled, so it has its own state union (the Pending/PR27 OrderState has no 'cancelled').

export type HistoryState = 'cancelled' | 'need_payment' | 'need_send' | 'ready_to_ship' | 'complete';

export interface HistoryRow {
  sales_id: string;
  customer_name: string | null;
  order_date: string | null;
  status: string | null;
  payment_status: string | null;
  sales_total_idr: number | null;
  paid_idr: number;
  balance: number;
  item_count: number;     // active (non-cancelled) lines
  state: HistoryState;
}
