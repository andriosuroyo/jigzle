// Shared types for the Outbound (Ship) module. Plain module (NO 'use server') so the actions
// file can export only async functions — a Next.js production-build requirement (the linux SWC
// on Vercel rejects a 'use server' module that exports anything but async functions, including
// interfaces/types; the local darwin SWC tolerates them, which is why the local build was green).

import type { ShipLine } from '@jigzle/db/types';

// ── the ship detail pane ──
export interface ShipDetail {
  sales_id: string;
  customer_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  status: string | null;
  address_id: number | null;
  ship_address: string | null;          // legacy single-line fallback (kept; O3 uses the fields below)
  // O3 copyable address block (verbatim raw_address; name/phone fall back to the customer):
  recipient_name: string | null;        // from the chosen address
  contact_phone: string | null;         // from the chosen address
  raw_address: string | null;           // VERBATIM — printed as-is, never rebuilt from columns
  planned_courier: string | null;       // base courier from fulfill (e.g. 'TIKI')
  courier_label: string | null;         // denormalized label from the line (e.g. 'TIKI ONS')
  courier_tracking: string | null;      // tracking entered at fulfill
  lines: ShipLine[];
  barcodes: { barcode: string; item_code: string }[]; // for scan verification
  pending_fulfill_count: number; // unshipped, non-cancelled lines NOT yet fulfilled
}

// ── commit the shipment ── (bill_by_volume dropped from the client per O9 — the column stays in DB
// defaulting false; chargeable is always max(real, vol) regardless.)
export interface BoxInput {
  real_weight: number | null;
  dim_p: number | null;
  dim_l: number | null;
  dim_t: number | null;
}

// 0035: how each line was checked at ship — 'scan' (barcode) carries the scanned code; 'manual' a tick.
// Written onto the outbound_shipments rows by record_shipment so the report/History ✅/○ marks populate.
export interface ShipVerify {
  line_id: string;
  method: 'scan' | 'manual';
  barcode: string | null;
}

// Courier + tracking are set at Fulfill now and travel on the line (O4) — Outbound never sends them.
export interface ShipInput {
  sales_id: string;
  line_ids: string[];
  boxes: BoxInput[];
  verify?: ShipVerify[];   // per-line verification captured at Mark-shipped (0035)
}

export interface ShipResult {
  affected: string[];
  stock: { item_code: string; available: number; physical: number; reserved: number }[];
}

// ── Outbound History (read-only) — now sourced from outbound_shipments, the canonical log, so the FULL
// shipped history shows (not just app-pipeline orders). Each shipment carries everything the detail
// needs, so the board renders the detail straight from the selected row (CSV/legacy rows have no
// sales_id to re-fetch by). ──
export interface ShipmentHistoryItem {
  item_code: string | null;                 // resolved catalogue code (or the raw code when unmatched)
  name: string;                              // catalogue name (falls back to the code)
  qty: number;
  verify_method: 'scan' | 'manual' | null;  // ✅ barcode-scanned | ○ manually checked | unknown
  scanned_barcode: string | null;           // the barcode read when scanned (kept for the report)
}

export interface ShipmentHistoryBox {
  real_weight: number | null;
  dim_p: number | null;
  dim_l: number | null;
  dim_t: number | null;
  chargeable_weight: number | null;
}

export interface ShipmentHistoryRow {
  key: string;                     // synthetic id (send_id, or a composite) — for React keys + selection
  ship_date: string | null;
  customer: string | null;
  address: string | null;          // verbatim, as shipped (the CSV address text / order address)
  courier: string | null;
  note: string | null;             // combined shipment notes (from Sales)
  items: ShipmentHistoryItem[];
  sku_codes: string[];             // for the SKU search / quick-view line
  item_count: number;
  real_weight: number | null;      // CSV: weight_gram; app ships: summed box real weights
  chargeable_g: number | null;     // CSV: weight_gram; app ships: summed box chargeable weights
  boxes: ShipmentHistoryBox[];     // real boxes for app ships; empty for CSV (→ assume Custom 1×1×1)
}
