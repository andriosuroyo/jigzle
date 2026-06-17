// Shared types for the SKU-image read path (docs/011 §5.1). Plain module (NO 'use server') so the
// actions file can export only async functions (the Vercel SWC rule).

import type { ImageStatus } from '@jigzle/db/types';

// one resolved SKU image: its status + the ready-to-use public CDN URL (null unless has_image)
export interface SkuImageEntry {
  status: ImageStatus;
  displayUrl: string | null;
}

// item_code → resolved image, for a screen's visible SKUs (one batch read, no N+1)
export type SkuImageMap = Record<string, SkuImageEntry>;
