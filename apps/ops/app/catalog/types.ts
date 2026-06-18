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
