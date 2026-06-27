// Shared types for the Fulfill module. Plain module (NO 'use server') so the actions file can
// export only async functions — a Next.js production-build requirement (the linux SWC on Vercel
// rejects a 'use server' module that exports anything but async functions, incl. interfaces).

import type { CustomerAddress } from '@jigzle/db/types';

// ── PR-B To-send queue (§5, FT-2/FT-3): orders with cut + courier-null + unshipped lines. The cut
// already happened (Pending / New); Fulfill confirms address + courier, then sends to Outbound. ──
export interface ToSendQueueRow {
  sales_id: string;
  order_date: string | null;
  customer_name: string | null;
  item_count: number;     // cut, courier-null, unshipped lines
  sku_codes: string[];    // for the preview SKU list (FT-3)
}

// ── send the cut set to Outbound (FT-6): set courier + (deferred) address via set_fulfillment ──
export interface SendToOutboundInput {
  sales_id: string;
  line_ids: string[];
  address_id: number;
  courier: string;                 // base courier name, e.g. 'TIKI'
  courier_speed?: string | null;   // speed tier, e.g. 'ONS'
  courier_label?: string | null;   // denormalized label, e.g. 'TIKI ONS'
  tracking?: string | null;
}

// ── one cut line in the Fulfill detail (FT-6: read-only — the whole cut set ships; no checkbox, no
// availability, no holds — the cut + hold-release already happened upstream at Pending / New) ──
export interface FulfillCutLine {
  line_id: string;
  item_code: string | null;
  name: string;
  qty: number;
  line_note: string | null; // per-line shipment note (editable here, shown in Outbound, locked in History)
}

// ── the detail pane (prep-only: confirm address + pick courier, then send to Outbound) ──
export interface FulfillDetail {
  sales_id: string;
  order_date: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  default_address_id: number | null; // the order's current address_id (null = SA-1 deferred)
  needs_address: boolean;            // address_id is null → must be set before sending to Outbound
  courier_tracking: string | null;   // tracking carried back from a "Return to Fulfill" (re-prefilled)
  lines: FulfillCutLine[];           // the cut, courier-null, unshipped lines
  addresses: CustomerAddress[];
}
