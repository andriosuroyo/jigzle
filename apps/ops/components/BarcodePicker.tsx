'use client';

// Shared shared-barcode picker (docs/016 F1). The composite (barcode, item_code) model (0020) means
// one scanned barcode can own >1 SKU; this is the "which SKU?" chooser that the scanner shows in
// that case. Presentational only — it owns no resolution: the caller resolves the scan and decides
// what onPick "means" (Count → increment; future Receiving → receive a unit). Built as a standalone
// component so Stock Check and Receiving converge on ONE picker (Receiving adopts it later).

import SkuImage from '@/components/SkuImage';
import type { ScanSku } from '@/app/stock-check/types';
import type { SkuImageMap } from '@/app/images/types';

export default function BarcodePicker({
  skus,
  imgMap,
  onPick,
  onCancel,
}: {
  skus: ScanSku[];
  imgMap: SkuImageMap;
  onPick: (sku: ScanSku) => void;
  onCancel: () => void;
}) {
  return (
    <div className="rcv-picker">
      <div className="rcv-picker-head">⚠ which SKU?</div>
      {skus.map((s) => (
        <button key={s.item_code} className="rcv-picker-opt" onClick={() => onPick(s)}>
          <SkuImage status={imgMap[s.item_code]?.status} displayUrl={imgMap[s.item_code]?.displayUrl} name={s.name} size={32} />
          <span className="ff-code">{s.item_code}</span>
          <span className="ff-name">{s.name}</span>
          {s.is_verified && <span className="badge ready">verified</span>}
        </button>
      ))}
      <button className="btn-link" onClick={onCancel}>cancel</button>
    </div>
  );
}
