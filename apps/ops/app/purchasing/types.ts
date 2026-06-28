// Shared types for the Procurement module. Plain module (NO 'use server') so the actions file
// can export only async functions — a Next.js production-build requirement (the linux SWC on
// Vercel rejects a 'use server' module that exports anything but async functions, including
// interfaces/types; the local darwin SWC tolerates them, which is why local builds stay green).

import type { SupplierType } from '@jigzle/db/types';

// Buy-priority flag (PR73): low / mid / high → green / yellow / red across the To-buy cards. Stored on
// purchase_orders.urgency (manual items) and orders.urgency (sales orders, surfaced on From-Sales cards).
export type Urgency = 'low' | 'mid' | 'high';

// SKU search hit for the PO form — live stock_check.available plus the incoming columns
// (D3: pending = Σ Processing POs, on_the_way = Σ 'On the way' / 'With Forwarder' POs). This is
// where incoming stock is surfaced (apps/ops has no standalone Stock Check screen yet). PR73 adds the
// brand name (matched via brands.name → brand_prefix) so the add-item search can find by brand too.
export interface SkuHit {
  item_code: string;
  name: string;
  brand: string | null;
  available: number;
  pending: number;
  on_the_way: number;
}

// PR73: the purchase links shown in the To-buy "Buy" overlay for one SKU — the buy-list item's own
// product link (if any) plus the catalogue's stored supplier sources (sku_sources). When both are
// empty the overlay offers "Mark as Out of Stock" only.
export interface BuyLinks {
  product_link: string | null;
  sources: string[];
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
  customer_id: number | null;
  customer_name: string | null;
  order_date: string | null;
  item_code: string | null;
  name: string;
  qty: number;
  available: number; // live stock_check.available (≤ 0 for a preorder)
  urgency: Urgency | null; // from the order (orders.urgency)
  product_link: string | null; // the order line's item_link, if any (used by the Buy overlay)
}

// ── To buy → Planned (manual buy-list; PO status 'Planned'). Created with no supplier yet. ──
export interface PlannedItemInput {
  item_code: string;
  qty: number;
  product_link?: string | null;
  item_note?: string | null;
  urgency?: Urgency | null;
}

export interface PlannedItemRow {
  po_id: number;
  item_code: string | null;
  name: string;
  qty: number;
  product_link: string | null;
  item_note: string | null;
  urgency: Urgency | null;
  available: number;     // live stock_check.available (warehouse)
  on_the_way: number;    // Σ 'On the way' PO qty (shipped, en route)
  with_forwarder: number; // Σ 'With Forwarder' PO qty (in forwarder)
}

// ── To buy → Sold out (PO status 'Sold out' + auto date + optional reason). ──
export interface SoldOutRow {
  po_id: number;
  item_code: string | null;
  name: string;
  qty: number;
  urgency: Urgency | null;
  product_link: string | null;
  sold_out_date: string | null;
  sold_out_note: string | null;
}

// ── live stock figures for the add-item overlay: warehouse / forwarder / shipped (en route). ──
export interface SkuStockInfo {
  item_code: string;
  available: number;
  on_the_way: number;     // 'On the way'
  with_forwarder: number; // 'With Forwarder'
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
  product_link: string | null;
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
  item_count: number;       // distinct Received SKUs on this ship_id
  total_cost: number | null; // Σ item_cost across the ship's Received lines (roll-up)
  suppliers: string[];      // distinct supplier names on the ship (roll-up)
}
