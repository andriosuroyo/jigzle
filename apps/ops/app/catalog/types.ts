// Shared types for the Catalogue (SKU editor) module. Plain module (NO 'use server') so the
// actions file can export only async functions — a Next.js production-build requirement (the linux
// SWC on Vercel rejects a 'use server' module that exports anything but async functions).

import type { BarcodeLink, CatalogueRow } from '@jigzle/db/types';

// one row in the search / needs-review list (left pane)
export interface CatalogueListRow {
  item_code: string;
  name: string;                 // translate_name || original_name || self_code || item_code
  brand_prefix: string | null;
  needs_review: boolean;
}

// the edit pane payload: the full SKU + its barcode links (with shared flags)
export interface SkuDetail {
  sku: CatalogueRow;
  barcodes: BarcodeLink[];
}

// ── Quick-add of a PARTIAL SKU from Stock Check (PR18 §6) ──────────────────────
// The product_type domain offered by the quick-add selector (live catalogue domain, 2026-06). Free
// text in the DB; this is just the picker. Anything unusual can be set later in /catalog.
export const PRODUCT_TYPES = [
  'Jigsaw Puzzle',
  '3D Puzzle',
  'Mini Block',
  'Accessories',
  'Crafts',
  'Board Game',
  'Games',
  'Misc Goods',
] as const;

// A product_type counts as a "puzzle" (→ needs a piece count to be complete) when it mentions puzzle
// (Jigsaw Puzzle, 3D Puzzle). Non-puzzle merch (keychains/plushies/gift boxes) is never piece-gated.
export function isPuzzle(productType: string | null | undefined): boolean {
  return !!productType && /puzzle/i.test(productType);
}

// fields the completion gate cares about (a subset of the catalogue row), shareable client+server.
export type GateFields = {
  brand_prefix: string | null;
  product_type: string | null;
  piece_count_n: number | null;
  original_name: string | null;
  translate_name: string | null;
};

// The completion gate (PR18 §6): a SKU is COMPLETE when it has a name + brand_prefix + product_type,
// AND a piece_count_n IF its product_type is a puzzle. (Region is not a column — dropped by 0010.)
// Returns the human-readable list of what's still missing ([] = complete).
export function missingForComplete(sku: GateFields): string[] {
  const missing: string[] = [];
  if (!((sku.translate_name ?? '').trim() || (sku.original_name ?? '').trim())) missing.push('name');
  if (!sku.brand_prefix) missing.push('brand');
  if (!((sku.product_type ?? '').trim())) missing.push('product type');
  if (isPuzzle(sku.product_type) && sku.piece_count_n == null) missing.push('piece count');
  return missing;
}

export function isComplete(sku: GateFields): boolean {
  return missingForComplete(sku).length === 0;
}

// Result of quickAddSku — created, or rejected because the item_code already exists (offer it), or
// an input/validation problem with a readable message (returned, not thrown — survives prod).
export type QuickAddResult =
  | { ok: true; item_code: string; barcodeWarning?: string } // SKU created (+ added); barcode may not have linked
  | { ok: false; reason: 'exists'; existing: { item_code: string; name: string } }
  | { ok: false; reason: 'invalid'; message: string };

// One SKU already carrying a barcode (the shared-barcode owner warning in quick-add).
export interface BarcodeOwner {
  item_code: string;
  name: string;
}
