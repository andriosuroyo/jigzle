// Shared types for the Fulfill module. Plain module (NO 'use server') so the actions file can
// export only async functions — a Next.js production-build requirement (the linux SWC on Vercel
// rejects a 'use server' module that exports anything but async functions, incl. interfaces).

import type { CustomerAddress, FulfillLine, Hold, PaymentStatus } from '@jigzle/db/types';

// ── the detail pane ──
export interface FulfillDetail {
  sales_id: string;
  customer_id: number | null;
  customer_name: string | null;
  customer_phone: string | null;
  payment_status: PaymentStatus | null;
  default_address_id: number | null; // the order's current address_id
  lines: FulfillLine[];
  addresses: CustomerAddress[];
  holds: Hold[]; // active holds matching a line's item_code (and this customer / customer-agnostic)
}

// ── commit the stock cut ──
export interface FulfillInput {
  sales_id: string;
  line_ids: string[];
  address_id: number;
  courier: string | null;          // base courier name, e.g. 'TIKI'
  courier_speed?: string | null;   // speed tier, e.g. 'ONS' (null = courier has no tiers)
  courier_label?: string | null;   // denormalized display label, e.g. 'TIKI ONS'
  tracking?: string | null;
}

export interface FulfillResult {
  affected: string[]; // item_codes whose stock moved
  stock: { item_code: string; available: number; reserved: number; physical: number }[];
}
