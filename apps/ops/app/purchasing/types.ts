// Shared types for the Procurement module. Plain module (NO 'use server') so the actions file
// can export only async functions — a Next.js production-build requirement (the linux SWC on
// Vercel rejects a 'use server' module that exports anything but async functions, including
// interfaces/types; the local darwin SWC tolerates them, which is why local builds stay green).

import type { SupplierType } from '@jigzle/db/types';

// SKU search hit for the PO form — live stock_check.available plus the incoming columns
// (D3: pending = Σ Processing POs, on_the_way = Σ 'On the way' / 'With Forwarder' POs). This is
// where incoming stock is surfaced (apps/ops has no standalone Stock Check screen yet).
export interface SkuHit {
  item_code: string;
  name: string;
  available: number;
  pending: number;
  on_the_way: number;
}

// customer search hit for the optional "for customer" field
export interface CustomerHit {
  customer_id: number;
  name: string | null;
  phone: string | null;
}

// the open-PO queue filter (status + supplier)
export interface OpenPOFilter {
  status?: string | null;
  supplier_id?: number | null;
}

// updatePO patch — the editable fields of an open PO (blocked once status = 'Received').
// ship_id: null detaches the PO from its shipment.
export interface UpdatePOPatch {
  supplier_id?: number;
  item_code?: string;
  qty?: number;
  item_cost?: number | null;
  method?: string | null;
  marketplace_order_id?: string | null;
  customer_id?: number | null;
  item_note?: string | null;
  ship_id?: string | null;
}

// inline "+ add supplier" input (name required; suppliers.name is unique)
export interface NewSupplierInput {
  name: string;
  country?: string | null;
  flag?: string | null;
  type?: SupplierType | null;
}

// inline "+ add forwarder" input (prefix required; forwarders.prefix is the PK)
export interface NewForwarderInput {
  prefix: string;
  name?: string | null;
  country?: string | null;
}

// one existing open shipment, for the "group into an existing ship_id" datalist
export interface OpenShipmentRow {
  ship_id: string;
  forwarder_prefix: string | null;
  origin_country: string | null;
  ship_date: string | null;
}

// ── To buy → Preorder list (read-only, derived from Sales): an unfulfilled order line whose SKU has
// ≤0 available — i.e. a customer ordered something we don't have stock for and must buy. ──
export interface PreorderRow {
  line_id: string;
  sales_id: string;
  customer_name: string | null;
  order_date: string | null;
  item_code: string | null;
  name: string;
  qty: number;
  available: number; // live stock_check.available (≤ 0 for a preorder)
}

// ── Purchasing History → Per item (read-only): a Received PO line — keeps per-item cost / shipID. ──
export interface ReceivedItemRow {
  po_id: number;
  item_code: string | null;
  name: string;
  qty: number;
  item_cost: number | null;
  ship_id: string | null;
  supplier_name: string | null;
  receive_date: string | null;
  marketplace_order_id: string | null;
}

// ── Purchasing History → Per shipment (read-only): one completed shipment, so shipment-level data
// (receive date, tracking) isn't duplicated across its item rows. ──
export interface ShipmentHistoryRow {
  ship_id: string;
  forwarder_prefix: string | null;
  origin_country: string | null;
  ship_date: string | null;
  received_date: string | null;
  tracking: string | null;
  item_count: number; // distinct Received SKUs on this ship_id
}
