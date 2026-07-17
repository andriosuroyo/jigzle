'use client';

// CN Packing List tab (PR203). Pick the Shipment_id (forwarder ship_id, e.g. "SUB 191") from
// Purchasing, enter one row per package (L/W/H + real weight + China box tracking), choose the
// volumetric divisor (5000/6000). Net weight = Σ volume weights, gross = Σ real weights, packages =
// row count. Shared shipment/box state lives in the board so the other CN docs can reuse it.

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { pdf } from '@react-pdf/renderer';
import { getShipmentBoxes } from '@/app/purchasing/actions';
import type { CnBox, CnShipmentRow } from '@/app/doc-generator/types';
import PackingListDoc, { type PackingBox } from './PackingListDoc';
import { ensureCjkFont } from './cjkFont';
import DropSearch from '@/components/DropSearch';

const PDFViewer = dynamic(() => import('@react-pdf/renderer').then((m) => m.PDFViewer), { ssr: false });

const box: React.CSSProperties = { border: '1px solid #d8d8d6', borderRadius: 8, padding: 12, marginBottom: 12, background: '#fff' };
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: '#555', display: 'block', marginBottom: 4 };
const inp: React.CSSProperties = { padding: '6px 8px', border: '1px solid #cfcfcd', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };

export const emptyBox = (): CnBox => ({ desc: '', p: '', l: '', t: '', realWeight: '' });

export type CnPackingProps = {
  shipments: CnShipmentRow[];
  shipId: string;
  setShipId: (v: string) => void;
  mark: string;
  setMark: (v: string) => void;
  boxes: CnBox[];
  setBoxes: (v: CnBox[]) => void;
  boxTracking: string;
  setBoxTracking: (v: string) => void;
  divisor: number;
  setDivisor: (v: number) => void;
};

export default function CnPackingTab({ shipments, shipId, setShipId, setMark, boxes, setBoxes, boxTracking, setBoxTracking, divisor, setDivisor }: CnPackingProps) {
  ensureCjkFont();
  const [downloading, setDownloading] = useState(false);

  // Pre-fill packages from the shipment's saved boxes (captured in Purchasing → History). Fetch once
  // per ship-id; only replace when saved boxes exist, so manual entry is never wiped.
  const prefilledFor = useRef<string>('');
  useEffect(() => {
    const sid = shipId.trim();
    if (!sid || prefilledFor.current === sid) return;
    prefilledFor.current = sid;
    getShipmentBoxes(sid)
      .then((rows) => {
        if (rows.length) {
          setBoxes(rows.map((b) => ({ desc: '', p: b.dim_p?.toString() ?? '', l: b.dim_l?.toString() ?? '', t: b.dim_t?.toString() ?? '', realWeight: b.real_weight?.toString() ?? '' })));
          // PR354 — seed the single box-tracking field from the saved per-box trackings (comma-joined).
          setBoxTracking([...new Set(rows.map((b) => (b.tracking ?? '').trim()).filter(Boolean))].join(', '));
        }
      })
      .catch(() => {});
  }, [shipId, setBoxes, setBoxTracking]);

  const pkgBoxes: PackingBox[] = useMemo(
    () => boxes
      .filter((b) => b.p || b.l || b.t || b.realWeight)
      .map((b) => ({ desc: b.desc, p: Number(b.p) || 0, l: Number(b.l) || 0, t: Number(b.t) || 0, realWeight: Number(b.realWeight) || 0 })),
    [boxes],
  );
  // PR354 — split the comma-separated box-tracking field into one entry per line on the doc.
  const trackingList = useMemo(() => boxTracking.split(',').map((t) => t.trim()).filter(Boolean), [boxTracking]);
  // PR352 — MARK&NO is always the shipment id now (the separate 麦头 field was removed); the doc adds a
  // "(1)/(2)…" suffix per extra carton. `mark` stays synced from the picker for the sibling CN Invoice.
  const markNo = shipId;
  const ready = pkgBoxes.length > 0 && !!markNo;

  // PR352 — the shipment picker is a searchable dropdown: only ACTIVE shipments (status ≠ 'completed'),
  // sorted A→Z (numeric-aware, so SUB 9 sorts before SUB 10). The current value is always kept selectable
  // even if it somehow isn't active, so a chosen shipment never vanishes from the field.
  const shipmentOpts = useMemo(() => {
    const active = shipments.filter((sh) => sh.status !== 'completed' || sh.shipId === shipId);
    return active
      .slice()
      .sort((a, b) => a.shipId.localeCompare(b.shipId, undefined, { numeric: true }))
      .map((sh) => ({ value: sh.shipId, label: `${sh.shipId}${sh.tracking ? ` · ${sh.tracking}` : ''}` }));
  }, [shipments, shipId]);

  const docEl = <PackingListDoc markNo={markNo} boxes={pkgBoxes} divisor={divisor} trackings={trackingList} />;

  function setBox(i: number, patch: Partial<CnBox>) {
    setBoxes(boxes.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  }
  function addBox() { setBoxes([...boxes, emptyBox()]); }
  function removeBox(i: number) { setBoxes(boxes.length > 1 ? boxes.filter((_, j) => j !== i) : boxes); }

  async function download() {
    setDownloading(true);
    try {
      const blob = await pdf(docEl).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `PackingList-${markNo.replace(/[\\/:*?"<>|\s]/g, '_')}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } finally { setDownloading(false); }
  }

  const cell = { ...inp, width: '100%' } as React.CSSProperties;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 440px) 1fr', gap: 16, padding: 16, alignItems: 'start', maxWidth: 1100, width: '100%', margin: '0 auto' }}>
      <div>
        <div style={box}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignItems: 'start' }}>
            <div>
              <label style={lbl}>Shipment ID</label>
              <DropSearch
                value={shipId || null}
                onChange={(v) => { setShipId(v); setMark(v); }}
                options={shipmentOpts}
                placeholder="— pick a shipment —"
                ariaLabel="Shipment ID"
                className="cn-doc-ds"
              />
            </div>
            <div>
              <label style={lbl}>Box tracking</label>
              <input style={{ ...inp, width: '100%' }} value={boxTracking} onChange={(e) => setBoxTracking(e.target.value)} placeholder="ZTO …, ZTO … (comma-separated)" />
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <label style={lbl}>Volumetric divisor</label>
            {[6000, 5000].map((d) => (
              <label key={d} style={{ marginRight: 14, fontSize: 13 }}>
                <input type="radio" name="divisor" checked={divisor === d} onChange={() => setDivisor(d)} /> ÷{d}
              </label>
            ))}
          </div>
        </div>

        <div style={box}>
          <label style={lbl}>Packages — one row per box (cm / kg)</label>
          <div style={{ display: 'grid', gridTemplateColumns: '20px 2.6fr 1fr 1fr 1fr 1fr 24px', gap: 6, fontSize: 10, color: '#888', fontWeight: 700, marginBottom: 4 }}>
            <div /><div>DESCRIPTION</div><div>LENGTH</div><div>WIDTH</div><div>HEIGHT</div><div>REAL WT</div><div />
          </div>
          {boxes.map((b, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '20px 2.6fr 1fr 1fr 1fr 1fr 24px', gap: 6, marginBottom: 6, alignItems: 'center' }}>
              {/* PR354 — light-grey running box number, so it's clear how many packages have been added. */}
              <div style={{ color: '#bbb', fontSize: 12, fontWeight: 700, textAlign: 'center' }}>{i + 1}</div>
              <input style={cell} value={b.desc} onChange={(e) => setBox(i, { desc: e.target.value })} placeholder="JIGSAW PUZZLE" />
              <input style={cell} inputMode="decimal" value={b.p} onChange={(e) => setBox(i, { p: e.target.value })} />
              <input style={cell} inputMode="decimal" value={b.l} onChange={(e) => setBox(i, { l: e.target.value })} />
              <input style={cell} inputMode="decimal" value={b.t} onChange={(e) => setBox(i, { t: e.target.value })} />
              <input style={cell} inputMode="decimal" value={b.realWeight} onChange={(e) => setBox(i, { realWeight: e.target.value })} />
              <button type="button" onClick={() => removeBox(i)} title="remove" style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#a00', fontSize: 16 }}>×</button>
            </div>
          ))}
          <button type="button" onClick={addBox} style={{ ...inp, cursor: 'pointer', background: '#f6f6f5', width: '100%', marginTop: 2 }}>+ Add package</button>
        </div>
      </div>

      <div style={{ position: 'sticky', top: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 10 }}>
          <div style={{ fontWeight: 700 }}>Preview {pkgBoxes.length ? `· ${pkgBoxes.length} package${pkgBoxes.length === 1 ? '' : 's'}` : ''}</div>
          <button type="button" onClick={download} disabled={!ready || downloading}
            style={{ marginLeft: 'auto', padding: '7px 14px', borderRadius: 6, border: 'none', background: ready ? '#724F33' : '#bbb', color: '#fff', fontWeight: 700, cursor: ready ? 'pointer' : 'default' }}>
            {downloading ? 'Generating…' : 'Download PDF'}
          </button>
        </div>
        <div style={{ height: 820, border: '1px solid #d8d8d6', borderRadius: 8, overflow: 'hidden', background: '#f4f4f2' }}>
          {ready ? (
            <PDFViewer width="100%" height="100%" showToolbar={false}>{docEl}</PDFViewer>
          ) : (
            <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 14, textAlign: 'center', padding: 20 }}>
              Enter at least one package (with a dimension or weight) to preview.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
