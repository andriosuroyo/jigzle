'use client';

// CN Invoice tab (PR204). Shares the picked shipment + packages with the CN Packing List (packages /
// net / gross roll-up derives from them). Adds a back-datable date, HAWB (prefilled from the
// shipment's import tracking), editable shipper/consignee presets, and declared qty/unit-price lines.

import { useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { pdf } from '@react-pdf/renderer';
import type { CnBox, CnShipmentRow } from '@/app/doc-generator/types';
import type { CnAddress } from '@/app/settings/types';
import CnInvoiceDoc, { type CnInvoiceLine } from './CnInvoiceDoc';
import { cnWeights, CN_SHIPPER_DEFAULT, CN_CONSIGNEE_DEFAULT } from './cnConstants';
import { todayDot } from './pdfUtil';
import { ensureCjkFont } from './cjkFont';
import DropSearch from '@/components/DropSearch';

const PDFViewer = dynamic(() => import('@react-pdf/renderer').then((m) => m.PDFViewer), { ssr: false });

const box: React.CSSProperties = { border: '1px solid #d8d8d6', borderRadius: 8, padding: 12, marginBottom: 12, background: '#fff' };
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: '#555', display: 'block', marginBottom: 4 };
const inp: React.CSSProperties = { padding: '6px 8px', border: '1px solid #cfcfcd', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', width: '100%' };

type LineInput = { description: string; qty: string; unitPrice: string };

export type CnInvoiceProps = {
  shipments: CnShipmentRow[];
  addresses: CnAddress[];
  shipId: string;
  setShipId: (v: string) => void;
  mark: string;
  boxes: CnBox[];
  divisor: number;
};

export default function CnInvoiceTab({ shipments, addresses, shipId, setShipId, mark, boxes, divisor }: CnInvoiceProps) {
  ensureCjkFont();
  const { packages, netWeight, grossWeight } = cnWeights(boxes, divisor);
  const shipment = shipments.find((s) => s.shipId === shipId);

  const [dateStr, setDateStr] = useState(todayDot());
  const [hawb, setHawb] = useState('');
  const [hawbTouched, setHawbTouched] = useState(false);
  const [shipper, setShipper] = useState(CN_SHIPPER_DEFAULT);
  const [consignee, setConsignee] = useState(CN_CONSIGNEE_DEFAULT);
  const [shipperSel, setShipperSel] = useState<string | null>(null);   // picked saved-address id (display)
  const [consigneeSel, setConsigneeSel] = useState<string | null>(null);
  const [lines, setLines] = useState<LineInput[]>([{ description: 'PUZZLE', qty: '', unitPrice: '' }]);
  const [downloading, setDownloading] = useState(false);

  // prefill HAWB from the shipment's import tracking until the user edits it
  useEffect(() => {
    if (!hawbTouched) setHawb(shipment?.tracking || '');
  }, [shipment, hawbTouched]);

  // PR356 — active shipments only, sorted A→Z (numeric-aware), matching CN Packing List's picker.
  const shipmentOpts = useMemo(() => shipments
    .filter((s) => s.status !== 'completed' || s.shipId === shipId)
    .slice()
    .sort((a, b) => a.shipId.localeCompare(b.shipId, undefined, { numeric: true }))
    .map((s) => ({ value: s.shipId, label: `${s.shipId}${s.tracking ? ` · ${s.tracking}` : ''}` })), [shipments, shipId]);

  // PR356 — one Settings list feeds both the shipper and consignee pickers; selecting fills the textarea.
  const addressOpts = useMemo(() => addresses.filter((a) => a.is_active).map((a) => ({ value: String(a.id), label: a.label })), [addresses]);
  function pickAddr(id: string, setText: (v: string) => void, setSel: (v: string | null) => void) {
    const a = addresses.find((x) => String(x.id) === id);
    if (a) { setText(a.address); setSel(id); }
  }

  const docLines: CnInvoiceLine[] = useMemo(
    () => lines.filter((l) => l.description || l.qty || l.unitPrice)
      .map((l) => ({ description: l.description, qty: Number(l.qty) || 0, unitPrice: Number(l.unitPrice) || 0 })),
    [lines],
  );
  const markNo = mark || shipId;
  const ready = !!markNo && docLines.length > 0;

  const docEl = <CnInvoiceDoc markNo={markNo} dateStr={dateStr} hawb={hawb} shipper={shipper} consignee={consignee} lines={docLines} packages={packages} netWeight={netWeight} grossWeight={grossWeight} />;

  function setLine(i: number, patch: Partial<LineInput>) { setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l))); }

  async function download() {
    setDownloading(true);
    try {
      const blob = await pdf(docEl).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `CnInvoice-${markNo.replace(/[\\/:*?"<>|\s]/g, '_')}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } finally { setDownloading(false); }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 440px) 1fr', gap: 16, padding: 16, alignItems: 'start', maxWidth: 1100, width: '100%', margin: '0 auto' }}>
      <div>
        <div style={box}>
          <label style={lbl}>Shipment (ship-id)</label>
          <DropSearch
            className="cn-doc-ds"
            value={shipId || null}
            onChange={(v) => setShipId(v)}
            options={shipmentOpts}
            placeholder="— pick a shipment —"
            ariaLabel="Shipment"
          />
          <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
            <div style={{ width: 140 }}><label style={lbl}>Date</label><input style={inp} value={dateStr} onChange={(e) => setDateStr(e.target.value)} placeholder="yyyy.mm.dd" /></div>
            <div style={{ flex: 1 }}><label style={lbl}>HAWB no</label><input style={inp} value={hawb} onChange={(e) => { setHawb(e.target.value); setHawbTouched(true); }} placeholder="import tracking" /></div>
          </div>
        </div>

        <div style={box}>
          <label style={lbl}>Shipper address (托运人)</label>
          <DropSearch className="cn-doc-ds" value={shipperSel} onChange={(v) => pickAddr(v, setShipper, setShipperSel)} options={addressOpts} placeholder="— pick a saved address —" ariaLabel="Shipper saved address" />
          <textarea style={{ ...inp, minHeight: 60, resize: 'vertical', marginTop: 6 }} value={shipper} onChange={(e) => { setShipper(e.target.value); setShipperSel(null); }} />
          <label style={{ ...lbl, marginTop: 10 }}>Consignee address (收件人)</label>
          <DropSearch className="cn-doc-ds" value={consigneeSel} onChange={(v) => pickAddr(v, setConsignee, setConsigneeSel)} options={addressOpts} placeholder="— pick a saved address —" ariaLabel="Consignee saved address" />
          <textarea style={{ ...inp, minHeight: 60, resize: 'vertical', marginTop: 6 }} value={consignee} onChange={(e) => { setConsignee(e.target.value); setConsigneeSel(null); }} />
        </div>

        <div style={box}>
          <label style={lbl}>Declared items</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 0.7fr 0.9fr 24px', gap: 6, fontSize: 10, color: '#888', fontWeight: 700, marginBottom: 4 }}>
            <div>DESCRIPTION</div><div>QTY</div><div>UNIT PRICE</div><div />
          </div>
          {lines.map((l, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.6fr 0.7fr 0.9fr 24px', gap: 6, marginBottom: 6, alignItems: 'center' }}>
              <input style={inp} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
              <input style={inp} inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
              <input style={inp} inputMode="decimal" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} />
              <button type="button" onClick={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : lines)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#a00', fontSize: 16 }}>×</button>
            </div>
          ))}
          <button type="button" onClick={() => setLines([...lines, { description: 'PUZZLE', qty: '', unitPrice: '' }])} style={{ ...inp, cursor: 'pointer', background: '#f6f6f5', marginTop: 2 }}>+ Add line</button>
        </div>
      </div>

      <div style={{ position: 'sticky', top: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 10 }}>
          <div style={{ fontWeight: 700 }}>Preview</div>
          <button type="button" onClick={download} disabled={!ready || downloading} style={{ marginLeft: 'auto', padding: '7px 14px', borderRadius: 6, border: 'none', background: ready ? '#724F33' : '#bbb', color: '#fff', fontWeight: 700, cursor: ready ? 'pointer' : 'default' }}>{downloading ? 'Generating…' : 'Download PDF'}</button>
        </div>
        <div style={{ height: 820, border: '1px solid #d8d8d6', borderRadius: 8, overflow: 'hidden', background: '#f4f4f2' }}>
          {ready ? <PDFViewer width="100%" height="100%" showToolbar={false}>{docEl}</PDFViewer> : (
            <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 14, textAlign: 'center', padding: 20 }}>Pick a shipment and add at least one declared line.</div>
          )}
        </div>
      </div>
    </div>
  );
}
