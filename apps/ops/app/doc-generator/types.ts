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

// One package on the CN Packing List. Dimensions in cm, real weight in kg, plus its China-domestic
// box tracking (e.g. "ZTO 79011515924946"). Entered here for now (net-new — not yet stored).
export type CnBox = {
  desc: string; // per-package DESCRIPTION (品名); falls back to "JIGSAW PUZZLE" when blank (PR352)
  p: string; // length
  l: string; // width
  t: string; // height
  realWeight: string;
  tracking: string;
};
