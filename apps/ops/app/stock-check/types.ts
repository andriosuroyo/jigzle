// Shared types for the Stock Check module (docs/016). Plain module (NO 'use server') so the
// actions file can export only async functions — the Vercel SWC production-build rule (same split
// as receiving/types.ts).

export type StockCheckMode = 'presence' | 'count';
export type StockCheckScope = 'all_active' | 'brand';
export type StockCheckStatus = 'open' | 'closed' | 'cancelled';
export type ReviewAction = 'zeroed' | 'ignored' | 'added';

// Display labels for the modes (PR16 §1) — interaction-named, not device-named. The DB `mode` enum
// stays presence/count; this is a UI-label mapping only.
export function modeLabel(mode: StockCheckMode): string {
  return mode === 'count' ? 'Scan' : 'Checkbox';
}
// the per-person verb for the session header line 2 ("Counted by Andrio" / "Checked by Andrio").
export function modeVerb(mode: StockCheckMode): string {
  return mode === 'count' ? 'Counted by' : 'Checked by';
}

// Result of openStockCheck — RETURNED (not thrown) so a readable message survives Next.js's
// production server-action error sanitization (a thrown error reaches the client as an opaque digest).
export type OpenResult = { ok: true; stock_check_id: number } | { ok: false; message: string };

// One brand option for the New-count scope picker (brands.prefix → brands.name).
export interface BrandOption {
  prefix: string;
  name: string | null;
}

// One row in the Counts session list (header + a few derived counts for the summary line).
export interface SessionRow {
  stock_check_id: number;
  mode: StockCheckMode;
  scope: StockCheckScope;
  scope_brands: string[] | null;
  status: StockCheckStatus;
  counted_by: string;
  note: string | null;
  started_at: string;
  closed_at: string | null;
  created_by: string | null;
  line_count: number;       // seeded + added lines
  confirmed_count: number;  // ticked / scanned
  changed_count: number;    // lines with a non-zero delta (after close)
}

// One per-SKU line in an open session or a snapshot. `physical` is the LIVE on-shelf number
// (the "expected qty" the operator sees); expected_physical/delta are stamped at close.
export interface LineRow {
  line_id: number;
  stock_check_id: number;
  item_code: string;
  name: string;
  brand_prefix: string | null;
  confirmed: boolean;
  counted_qty: number | null;
  expected_physical: number | null;
  delta: number | null;
  review_action: ReviewAction | null;
  added_missing: boolean;
  physical: number; // live stock_check.physical (0 for an added-missing SKU off the shelf)
}

// One row in the Adjustments ledger (with the resolved SKU name).
export interface AdjustmentRow {
  adjustment_id: number;
  item_code: string;
  name: string;
  delta: number;
  source: 'stock_check' | 'manual';
  stock_check_id: number | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
}

export interface AdjustmentFilter {
  search?: string;
  source?: 'all' | 'stock_check' | 'manual';
  from?: string; // 'YYYY-MM-DD' inclusive
  to?: string;   // 'YYYY-MM-DD' inclusive
}

// New-count form payload → open_stock_check.
export interface NewCountInput {
  mode: StockCheckMode;
  scope: StockCheckScope;
  brands: string[]; // brand_prefix[]; empty for all_active
  counted_by: string;
  note?: string | null;
}

// One per-SKU decision collected by the close-confirm window.
export interface CloseReviewEntry {
  item_code: string;
  action: 'zeroed' | 'ignored';
}

// Result of close_stock_check.
export interface CloseSummary {
  stock_check_id: number;
  confirmed: number;
  changed: number;
  net: number;
  adjustments: { item_code: string; delta: number }[];
}

// ── scan resolution (Count mode) — mirrors receiving's ResolveResult, kept self-contained so the
//    module never imports across the receiving route (rename-safe). ──
export interface ScanSku {
  item_code: string;
  name: string;
  is_verified: boolean;
}
export type ScanResolve =
  | { status: 'resolved'; sku: ScanSku }
  | { status: 'collision'; skus: ScanSku[] }
  | { status: 'not_found'; code: string };

// manual SKU search (catalogue + barcode) with live available, for add-missing.
export interface SkuHit {
  item_code: string;
  name: string;
  available: number;
}

// ── close-confirm window data (shared component) ──
// countDeltas: Count auto-deltas that WILL be written (informational).
// decisions:   in-scope SKUs needing a per-row set-0 / leave choice (Count un-scanned / Presence un-ticked).
// added:       added-missing SKUs (+qty, informational).
export interface CloseConfirmData {
  mode: StockCheckMode;
  countDeltas: { item_code: string; name: string; expected: number; counted: number; delta: number }[];
  decisions: { item_code: string; name: string; expected: number }[];
  added: { item_code: string; name: string; qty: number }[];
}
