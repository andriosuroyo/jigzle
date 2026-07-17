// Shared UI types for the Doc Generator (PR202). Phase 1 covers the IDR + USD invoices; the CN docs
// and SP Declare land in later phases.

export type InvoiceCustomerRow = { id: number; name: string | null; phone: string | null };

export type InvoiceAddress = {
  addressId: number;
  label: string | null;
  recipientName: string | null;
  contactPhone: string | null;
  rawAddress: string | null;
};

export type InvoiceLine = {
  lineId: number;
  orderId: string; // sales_id
  itemCode: string; // item_code_raw (as shown to the customer)
  name: string; // resolved catalogue name
  qty: number;
  imageUrl: string | null; // resolved sku-images CDN url, or null (blank cell)
};

export type InvoiceOrder = {
  orderId: string; // sales_id
  orderDate: string | null;
  lines: InvoiceLine[];
};

export type InvoiceCustomerData = {
  customerId: number;
  name: string | null;
  phone: string | null;
  addresses: InvoiceAddress[];
  orders: InvoiceOrder[];
};

// ── China customs docs (Phase 2) ──

// A forwarder/import shipment, picked as the "Shipment_id" (ship_id, e.g. "SUB 191") that the CN
// Packing List / Invoice / Shipping all key off. tracking/courier are the import HAWB + carrier.
export type CnShipmentRow = {
  shipId: string;
  tracking: string | null;
  courier: string | null;
  shipDate: string | null;
  status: string | null;
};

// PR359 — read-only "from Purchasing" reference for a picked shipment, shown beside the CN Packing List
// / CN Invoice pickers so the operator can cross-check cost, packaging and tracking against Purchasing.
export type CnShipmentRefBox = { p: number | null; l: number | null; t: number | null; w: number | null; tracking: string | null };
export type CnShipmentRef = {
  itemLines: number;          // PO lines in the shipment
  totalUnits: number;         // Σ qty
  totalCost: number | null;   // Σ item_cost × qty (null if no costs recorded)
  currencySymbol: string;     // '元' / '¥' / '$' … from the supplier country ('' if unknown)
  boxes: CnShipmentRefBox[];
  consolidatorCourier: string | null;
  consolidatorTracking: string | null;
  shipmentCourier: string | null;
  shipmentTracking: string | null;
  shipDate: string | null;
};

// One package on the CN Packing List. Dimensions in cm, real weight in kg. Entered here for now
// (net-new — not yet stored). Box tracking is no longer per-box: it's a single comma-separated field
// on the tab (PR354), rendered as one line per number on the packing list.
export type CnBox = {
  desc: string; // per-package DESCRIPTION (品名); falls back to "JIGSAW PUZZLE" when blank (PR352)
  p: string; // length
  l: string; // width
  t: string; // height
  realWeight: string;
};
