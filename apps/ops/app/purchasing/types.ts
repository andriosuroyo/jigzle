// Shared types for the Procurement module. Plain module (NO 'use server') so the actions file
// can export only async functions — a Next.js production-build requirement (the linux SWC on
// Vercel rejects a 'use server' module that exports anything but async functions, including
// interfaces/types; the local darwin SWC tolerates them, which is why local builds stay green).

import type { SupplierType } from '@jigzle/db/types';

// Buy-priority flag (PR73): low / mid / high → green / yellow / red across the To-buy cards. Stored on
// purchase_orders.urgency (manual items) and orders.urgency (sales orders, surfaced on From-Sales cards).
export type Urgency = 'low' | 'mid' | 'high';

// SKU search hit for the PO form — the same three pipeline figures the cards/selected view show, so
// a search result reads as a quick-view: warehouse (stock_check.available), at-forwarder ('With
// Forwarder' PO qty) and shipped ('On the way' PO qty). PR73 adds the brand name (matched via
// brands.name → brand_prefix) so the add-item search can find by brand too.
export interface SkuHit {
  item_code: string;
  name: string;
  brand: string | null;
  available: number;       // warehouse
  pending: number;         // Σ Processing POs (used by the To-forwarder OrderBoard search)
  with_forwarder: number;  // at forwarder
  on_the_way: number;      // shipped (en route)
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
  statuses?: string[];        // bucket fetch (e.g. ['Processing','On the way']); overrides the default open filter
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
  product_link?: string | null;
  tracking_to_forwarder?: string | null;
  ship_id?: string | null;
}

// inline "+ add supplier" input (name required; suppliers.name is unique)
export interface NewSupplierInput {
  name: string;
  country?: string | null;
  flag?: string | null;
  type?: SupplierType | null;
}

// Settings → Suppliers edit patch (name unique; all fields optional on update)
export interface UpdateSupplierPatch {
  name?: string;
  country?: string | null;
  flag?: string | null;
  type?: SupplierType | null;
}

// "+ add forwarder" input (prefix required; forwarders.prefix is the PK)
export interface NewForwarderInput {
  prefix: string;
  name?: string | null;
  country?: string | null;
  flag?: string | null;
  logo?: string | null;
}

// Settings → Consolidators edit patch (all optional; prefix is renamed via renameConsolidatorPrefix)
export interface UpdateForwarderPatch {
  name?: string | null;
  country?: string | null;
  flag?: string | null;
  logo?: string | null;
}

// one existing open shipment, for the "group into an existing ship_id" datalist
export interface OpenShipmentRow {
  ship_id: string;
  forwarder_prefix: string | null;
  origin_country: string | null;
  ship_date: string | null;
  note: string | null; // per-Ship-ID note (shown on the Inbound receive detail)
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
  // PR405 — an UNCODED line (item_code NULL: a PR404 custom item / a legacy import) carries its typed
  // code here, the same placeholder shape as a Planned item (PR231). Resolved to a real SKU at Inbound.
  item_code_raw: string | null;
  name: string;
  qty: number;
  available: number; // live stock_check.available (≤ 0 for a preorder; always 0 for an uncoded line)
  urgency: Urgency | null; // from the order (orders.urgency)
  line_note: string | null; // the order line's note (order_lines.line_note) — editable via Edit PO (PR254)
  product_link: string | null; // the order line's item_link, if any (used by the Buy overlay)
  // PR304 — out-of-stock is now an inline flag (no separate list). A From-Sales line is flagged by a
  // 'Sold out' PO created for it; oos_po_id is that PO (so unchecking can delete it).
  out_of_stock: boolean;
  oos_po_id: number | null;
}

// ── To buy → Planned (manual buy-list; PO status 'Planned'). Created with no supplier yet. ──
export interface PlannedItemInput {
  // PR231 — a known SKU FKs via item_code; a brand-new/unknown code is stored as a placeholder in
  // item_code_raw (item_code NULL) and resolved to a real SKU at Inbound receive. Exactly one is set.
  item_code?: string | null;
  item_code_raw?: string | null;
  qty: number;
  product_link?: string | null;
  item_note?: string | null;
  urgency?: Urgency | null;
}

export interface PlannedItemRow {
  po_id: number;
  item_code: string | null;
  item_code_raw: string | null; // PR231 — the placeholder code shown when item_code is NULL (unknown SKU)
  name: string;
  qty: number;
  product_link: string | null;
  item_note: string | null;
  urgency: Urgency | null;
  input_date: string | null; // create date (when the item was added to the buy-list)
  supplier_id: number | null; // PR283 — the Source (mandatory before Done)
  available: number;     // live stock_check.available (warehouse)
  on_the_way: number;    // Σ 'On the way' PO qty (shipped, en route)
  with_forwarder: number; // Σ 'With Forwarder' PO qty (in forwarder)
  // PR304 — inline out-of-stock flag (PO status 'Sold out'); the item stays in the Manual list.
  out_of_stock: boolean;
}

// ── To buy → Out of Stock (PO status 'Sold out' + auto date + optional reason). The card mirrors its
// origin: a manual-origin row shows the pipeline figures (available/with_forwarder/on_the_way); a
// sales-origin row (created from a From-Sales preorder) shows the order context (sales_id/customer/date)
// and is read-only on qty. ──
export interface SoldOutRow {
  po_id: number;
  item_code: string | null;
  item_code_raw: string | null; // PR231 — placeholder code when item_code is NULL (unknown SKU)
  name: string;
  qty: number;
  urgency: Urgency | null;
  product_link: string | null;
  sold_out_date: string | null;
  sold_out_note: string | null;
  origin: 'manual' | 'sales';
  sales_id: string | null;
  customer_name: string | null;
  order_date: string | null;
  input_date: string | null; // create date (manual origin) — the date kept from before it went out of stock
  supplier_id: number | null; // PR283 — the Source (mandatory before Done)
  available: number;
  with_forwarder: number;
  on_the_way: number;
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
  receive_date: string | null; // inbound-backed received date (null ⇒ not yet received)
  ship_date: string | null;    // the shipment's ship date (shown when not yet received)
  marketplace_order_id: string | null;
  product_link: string | null;
}

// one SKU line within a shipment (History → shipment detail)
export interface ShipmentItemRow {
  po_id: number;
  item_code: string | null;
  name: string;
  qty: number;
  item_cost: number | null;
  currency: string | null; // from the line's supplier country (yuan / yen …) for the "each" label
  // PR255 — the per-PO detail captured at To forwarder, surfaced (and editable) when a History item card
  // is tapped. All optional / nullable.
  supplier_id: number | null;
  supplier_name: string | null;
  method: string | null;                 // local courier (domestic leg to the forwarder)
  tracking_to_forwarder: string | null;  // local tracking number
  marketplace_order_id: string | null;   // marketplace order id
  item_note: string | null;
  product_link: string | null;
  input_date: string | null;
}

// PR206 (0069): a box on an import shipment — dims (cm) + real weight (kg) + China box tracking.
// Captured in Purchasing History detail; pre-fills the Doc Generator CN Packing List.
export interface ShipmentBox {
  dim_p: number | null;
  dim_l: number | null;
  dim_t: number | null;
  real_weight: number | null;      // kg (the CN Packing List reads kg)
  description: string | null;      // PR — per-box 品名 (DESCRIPTION on the CN Packing List); 0120
  courier: string | null;          // PR261 — China-domestic box courier (paired with tracking)
  tracking: string | null;
}

// ── Purchasing History → Per shipment (read-only): one completed shipment, so shipment-level data
// (receive date, tracking) isn't duplicated across its item rows. ──
export interface ShipmentHistoryRow {
  ship_id: string;
  forwarder_prefix: string | null;
  origin_country: string | null;
  ship_date: string | null;
  received_date: string | null;
  tracking: string | null;              // PR272: shipment tracking (Shipper → Jigzle leg)
  consolidator_courier: string | null;  // PR274: consolidator courier (Consolidator → Shipper leg)
  consolidator_tracking: string | null; // PR272: consolidator tracking (Consolidator → Shipper leg)
  courier: string | null;    // PR153: the international carrier (DHL/MTE…) — shown beside tracking
  completed: boolean;        // shipment status = completed (Completed tab) vs open (Active tab)
  note: string | null;       // the per-Ship-ID note (editable here + in To-ship; shown on Inbound too)
  item_count: number;        // distinct items on this ship_id (POs ∪ inbound-received)
  sku_codes: string[];       // the distinct item identifiers, for the SKU search
  sku_names: string[];       // the items' catalogue names (PR153 — the search matches these too)
  local_trackings: string[]; // PR272: per-PO local trackings on this ship (Item → Consolidator), for search
  total_cost: number | null; // Σ item_cost×qty across the ship's PO lines (roll-up)
  currency: string | null;   // currency label from the forwarder's country (yuan / yen / NTD …)
  suppliers: string[];       // distinct supplier names on the ship (roll-up)
}
