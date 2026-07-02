// Shared types for the Receiving (Inbound) module. Plain module (NO 'use server') so the actions
// file can export only async functions — a Next.js production-build requirement (the linux SWC on
// Vercel rejects a 'use server' module that exports anything but async functions, incl. interfaces).

import type { ExpectedLine } from '@jigzle/db/types';

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

// ── manual SKU search via the shared search_skus RPC (PR28; same shape as Sales/Stock-Check). ──
// `on_the_way` (PR23/0027) rides along from the RPC but is UNUSED here — Inbound only shows `available`.
export interface SkuHit {
  item_code: string;
  name: string;
  available: number;
  on_the_way: number;
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
  qty: number; // signed counted (TOTAL arrived; allocation base)
  excluded: boolean; // legacy whole-line flag (kept for back-compat)
  excluded_qty: number | null; // how many of qty arrived damaged → 0 sellable
  exclude_reason: string | null; // short text reason ("damaged box")
  label: string | null; // free text from settings_inbound_labels (PR28/0031)
  dimension_weight: string | null;
}
export interface RecordReceiptInput {
  ship_id: string;
  receive_date: string; // 'YYYY-MM-DD'
  lines: RecordReceiptLine[];
  close_shipment: boolean;
  staff?: string | null; // 0052: the active warehouse staff, stamped onto the inbound rows
}
export interface RecordReceiptResult {
  receipt_id: number; // the reversible-unit handle (Reverse needs it)
  closed: boolean; // the shipment was closed by this receipt
  affected: string[];
  stock: { item_code: string; available: number; physical: number; last_receive: string | null }[];
}

// ── reverse a confirmed receipt (mis-count recovery) ──
export interface ReverseResult {
  receipt_id: number;
  affected: string[];
  stock: { item_code: string; available: number; physical: number; last_receive: string | null }[];
}

// ── §5 ship-id suggestion: a scanned SKU → candidate open ship_ids with an open PO line for it ──
export interface ShipIdSuggestion {
  ship_id: string;
  origin_country: string | null;
  ship_date: string | null;
  open_qty: number; // Σ open PO qty for the scanned SKU on this ship_id
}

// ── Inbound History (read-only) — confirmed receipts grouped per ship_id, newest first. Sourced from
// the inbound ledger (the canonical "what arrived"), so it covers both real shipments and 📦 ad-hoc
// receives. Each row carries everything the detail pane needs to render straight from the selection. ──
export interface InboundHistoryItem {
  item_code: string | null;          // resolved catalogue code (or the raw code when unmatched)
  name: string;                      // catalogue name (falls back to the code)
  qty: number;                       // Σ sellable received (signed; excludes the damaged subset)
  excluded_qty: number;              // Σ arrived-but-damaged (0 sellable)
}

export interface InboundHistoryRow {
  ship_id: string;                   // the join key + React key + selection id
  receive_date: string | null;       // latest receive_date across this shipment's rows
  received_at: string | null;        // 0052: latest created_at (timestamptz) — drives the date+time display
  staff: string | null;              // 0052: who received (from the latest receipt row in the group)
  origin_country: string | null;
  tracking: string | null;
  is_adhoc: boolean;                 // a 📦YYMMXXX id with no shipments-ledger row
  items: InboundHistoryItem[];
  sku_codes: string[];               // A-Z, for the SKU search / quick-view line
  item_count: number;                // distinct SKUs received
  total_qty: number;                 // Σ sellable units received
}

// ── receive close-confirm window (ReceiveConfirm; reuses the .sc-modal* chrome) ──
// per SKU: expected (open PO qty) vs counted, classified; shorts revert only on close.
export type ReceiveClass = 'ok' | 'short' | 'over' | 'unexpected';
export interface ReceiveConfirmRow {
  item_code: string;
  name: string;
  expected: number; // open PO qty on the ship_id (0 = unexpected)
  counted: number; // total arrived (incl. excluded)
  excluded_qty: number; // damaged subset of counted
  cls: ReceiveClass;
}
export interface ReceiveConfirmData {
  ship_id: string;
  is_shipment: boolean;
  rows: ReceiveConfirmRow[];
  shorts: string[]; // item_codes that will revert on close (expected > counted)
}
