// PR172 — per-SKU stock ledger (Inventory drill-down). Every in/out movement for one SKU with a
// running balance: opening balance (pinned first), receipts (inbound +), sales (shipped −), and
// manual/count adjustments (±). The final running balance equals the SKU's current physical stock.

export type LedgerKind = 'opening' | 'inbound' | 'sale' | 'adjustment';

export interface LedgerEntry {
  date: string | null; // movement date (receive_date / shipped_at / created_at)
  kind: LedgerKind;
  delta: number; // signed: + in, − out
  label: string; // human description (e.g. "Received · SUB 191", "Sale — Louis T (3023)")
  ref: string | null; // ship_id / sales_id, for the operator to cross-reference
  balance: number; // running balance AFTER this entry
}

export interface SkuLedger {
  item_code: string;
  name: string | null;
  physical: number; // current on-shelf (should equal the last entry's running balance)
  available: number; // current free-to-sell
  entries: LedgerEntry[]; // oldest → newest (opening balance first)
}
