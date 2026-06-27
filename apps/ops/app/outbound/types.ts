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

// Courier + tracking are set at Fulfill now and travel on the line (O4) — Outbound never sends them.
export interface ShipInput {
  sales_id: string;
  line_ids: string[];
  boxes: BoxInput[];
}

export interface ShipResult {
  affected: string[];
  stock: { item_code: string; available: number; physical: number; reserved: number }[];
}

// ── Outbound History row (orders we've shipped; read-only) ──
export interface ShippedOrderRow {
  sales_id: string;
  order_date: string | null;
  customer_name: string | null;
  ship_date: string | null;        // most recent shipped_at across the order's lines
  item_count: number;              // shipped lines
  sku_codes: string[];             // for the SKU search
  courier_label: string | null;
  courier_tracking: string | null;
}
