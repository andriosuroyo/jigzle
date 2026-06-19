'use client';

// Scan-mode review strip (PR22 §3). Anything that isn't a clean count is held HERE — never silently
// dropped — so the operator (or a supervisor on return) resolves it. Four kinds, each with an action:
//   double  — a merged double scan (~20–28 digits); shows the raw + an "accept as 2 scans" button when
//             a valid split was found (both halves resolved), else just "dismiss".
//   garbled — wrong length / failed check digit; raw + "dismiss".
//   collision — a shared barcode owning >1 SKU; an inline BarcodePicker (picking counts +1).
//   unknown — a barcode that resolved to nothing; an inline QuickAddForm seeded with the raw barcode
//             (create the SKU → it joins Scanned at qty 1), plus "dismiss".
// Presentational: it owns no resolution. Resolving or dismissing removes the item (parent state).

import BarcodePicker from '@/components/BarcodePicker';
import { QuickAddForm } from '@/components/SkuSearchAdd';
import type { ScanSku } from '@/app/stock-check/types';
import type { SkuImageMap } from '@/app/images/types';

export type HeldKind = 'double' | 'garbled' | 'collision' | 'unknown';

export interface DoubleSplit {
  a: string;
  b: string;
  skuA: ScanSku;
  skuB: ScanSku;
}

export interface Held {
  id: string;
  kind: HeldKind;
  raw: string;
  ts: number;
  skus?: ScanSku[]; // collision — the SKUs sharing the barcode
  split?: DoubleSplit | null; // double — the resolved split, or null when none was found
}

const KIND_LABEL: Record<HeldKind, string> = {
  double: 'possible double',
  garbled: 'garbled scan',
  collision: 'shared barcode',
  unknown: 'unknown barcode',
};

export default function ScanReviewStrip({
  held,
  imgMap,
  onAcceptDouble,
  onPick,
  onAddUnknown,
  onDismiss,
}: {
  held: Held[];
  imgMap: SkuImageMap;
  onAcceptDouble: (h: Held) => void;
  onPick: (h: Held, sku: ScanSku) => void;
  onAddUnknown: (h: Held, code: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (held.length === 0) return null;
  return (
    <div className="sc-review" role="region" aria-label="scans needing review">
      <div className="sc-review-head">⚠ {held.length} scan{held.length === 1 ? '' : 's'} need review — resolve or dismiss</div>
      {held.map((h) => (
        <div key={h.id} className="sc-review-item">
          <div className="sc-review-line">
            <span className="sc-review-kind">{KIND_LABEL[h.kind]}</span>
            <span className="sc-review-raw">{h.raw}</span>
            {h.kind !== 'collision' && h.kind !== 'unknown' && (
              <span className="sc-review-actions">
                {h.kind === 'double' && h.split && (
                  <button className="btn-secondary sc-mini" onClick={() => onAcceptDouble(h)}>
                    accept as 2: +{h.split.skuA.item_code}, +{h.split.skuB.item_code}
                  </button>
                )}
                {h.kind === 'double' && !h.split && <span className="sc-exp">no clean split</span>}
                <button className="btn-link" onClick={() => onDismiss(h.id)}>dismiss</button>
              </span>
            )}
          </div>

          {h.kind === 'collision' && h.skus && (
            <BarcodePicker
              skus={h.skus}
              imgMap={imgMap}
              onPick={(sku) => onPick(h, sku)}
              onCancel={() => onDismiss(h.id)}
            />
          )}

          {h.kind === 'unknown' && (
            <QuickAddForm
              initialCode=""
              initialBarcode={h.raw}
              onAdd={(code) => onAddUnknown(h, code)}
              onClose={() => onDismiss(h.id)}
              onCancel={() => onDismiss(h.id)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
