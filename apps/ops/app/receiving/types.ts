// Shared types for the Receiving (Inbound) module. Plain module (NO 'use server') so the actions
// file can export only async functions — a Next.js production-build requirement (the linux SWC on
// Vercel rejects a 'use server' module that exports anything but async functions, incl. interfaces).

import type { ExpectedLine, InboundLabel } from '@jigzle/db/types';

// ── the receive detail: the expected list (contents ∪ POs) + barcodes for scan resolution ──
export interface ReceiveDetail {
  ship_id: string;
  origin_country: string | null;
  ship_date: string | null;
  tracking: string | null;
  is_shipment: boolean; // the ship_id is a real shipments-ledger row (vs an ad-hoc id)
  expected: ExpectedLine[];
  barcodes: { barcode: string; item_code: string }[]; // for the expected SKUs (instant scan)
}

// ── scan resolution: barcode → SKU, a collision picker (D1), or not-found (D2) ──
export interface ResolvedSku {
  item_code: string;
  name: string;
  is_verified: boolean;
}
export type ResolveResult =
  | { status: 'resolved'; sku: ResolvedSku }
  | { status: 'collision'; skus: ResolvedSku[] }
  | { status: 'not_found'; code: string };

// ── manual SKU search (catalogue text + barcode), with live available, for adding a line ──
export interface SkuHit {
  item_code: string;
  name: string;
  available: number;
}

// ── D2: create a minimal needs_review SKU stub for an unknown barcode ──
export interface StubInput {
  item_code: string;
  name: string;
  brand_prefix?: string | null;
  barcode?: string | null; // the scanned barcode to link to the new SKU
}

// ── commit the receipt (atomic, via record_receipt) → refreshed stock ──
export interface RecordReceiptLine {
  item_code: string;
  qty: number; // signed
  excluded: boolean;
  label: InboundLabel | null;
  dimension_weight: string | null;
}
export interface RecordReceiptInput {
  ship_id: string;
  receive_date: string; // 'YYYY-MM-DD'
  lines: RecordReceiptLine[];
  close_shipment: boolean;
}
export interface RecordReceiptResult {
  affected: string[];
  stock: { item_code: string; available: number; physical: number; last_receive: string | null }[];
}
