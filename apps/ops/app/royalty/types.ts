// Clover Royalty (PR392) — shared types for the Royalty screen + its Settings sub-editor.

export interface RoyaltyEntity {
  id: number;
  name: string;
  is_active: boolean;
  sort_order: number;
}

// one row of an entity's rate schedule: piece count → royalty in FULL IDR.
export interface RoyaltyRateRow {
  id: number;
  entity: string;
  pieces: number;
  royalty_idr: number;
}

// one royalty-owing sold-and-shipped line, for the Royalty page cards.
export interface RoyaltyLine {
  line_id: string;
  item_code: string | null;
  name: string;
  sold_date: string | null;   // when it became PAID + SENT (order_lines.shipped_at); null → fell back to fulfill_date
  paid_date: string | null;   // when the royalty payout was recorded (null while unpaid)
  qty: number;
  royalty_idr: number;
  paid: boolean;
}

export interface RoyaltyLedger {
  lines: RoyaltyLine[];
  unpaid_idr: number;
  unpaid_usd: number | null;   // null when no USD rate is available
  paid_idr: number;
  usd_rate: number | null;     // 1 USD = N IDR (from currencies)
  synced: number;              // how many new qualifying lines were accrued on this load
}
