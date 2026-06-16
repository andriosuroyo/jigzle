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
  ship_address: string | null;
  planned_courier: string | null;
  lines: ShipLine[];
  barcodes: { barcode: string; item_code: string }[]; // for optional scan resolution
  pending_fulfill_count: number; // unshipped, non-cancelled lines NOT yet fulfilled
}

// ── commit the shipment ──
export interface BoxInput {
  real_weight: number | null;
  dim_p: number | null;
  dim_l: number | null;
  dim_t: number | null;
  bill_by_volume: boolean;
}

export interface ShipInput {
  sales_id: string;
  line_ids: string[];
  courier: string | null;
  tracking?: string | null;
  boxes: BoxInput[];
}

export interface ShipResult {
  affected: string[];
  stock: { item_code: string; available: number; physical: number; reserved: number }[];
}
