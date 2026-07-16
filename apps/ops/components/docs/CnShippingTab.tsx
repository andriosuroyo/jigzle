'use client';

// CN Shipping tab (PR204). The forwarder's debit note. Shares the picked shipment + packages with the
// CN Packing List (PCS/GW/charge weight derive from them). Adds debit-note no, date, HAWB (prefilled
// from the shipment's import tracking), rate/kg and fee/box; freight = rate × charge weight, customs =
// fee × packages, total in RMB.

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { pdf } from '@react-pdf/renderer';
import type { CnBox, CnShipmentRow } from '@/app/doc-generator/types';
import CnShippingDoc from './CnShippingDoc';
import { cnWeights, shipPrefix } from './cnConstants';
import { todayDot } from './pdfUtil';
import { ensureCjkFont } from './cjkFont';

const PDFViewer = dynamic(() => import('@react-pdf/renderer').then((m) => m.PDFViewer), { ssr: false });

const box: React.CSSProperties = { border: '1px solid #d8d8d6', borderRadius: 8, padding: 12, marginBottom: 12, background: '#fff' };
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: '#555', display: 'block', marginBottom: 4 };
const inp: React.CSSProperties = { padding: '6px 8px', border: '1px solid #cfcfcd', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', width: '100%' };

export type CnShippingProps = {
  shipments: CnShipmentRow[];
  shipId: string;
  setShipId: (v: string) => void;
  boxes: CnBox[];
  divisor: number;
};

export default function CnShippingTab({ shipments, shipId, setShipId, boxes, divisor }: CnShippingProps) {
  ensureCjkFont();
  const { packages, netWeight, grossWeight, chargeWeight } = cnWeights(boxes, divisor);
  const shipment = shipments.find((s) => s.shipId === shipId);

  const [messers, setMessers] = useState('');
  const [debitNo, setDebitNo] = useState('');
  const [dateStr, setDateStr] = useState(todayDot());
  const [hawb, setHawb] = useState('');
  const [hawbTouched, setHawbTouched] = useState(false);
  const [ratePerKg, setRatePerKg] = useState('');
  const [feePerBox, setFeePerBox] = useState('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => { if (!hawbTouched) setHawb(shipment?.tracking || ''); }, [shipment, hawbTouched]);

  const ready = !!shipId && (!!ratePerKg || !!feePerBox);
  const docEl = (
    <CnShippingDoc
      messers={messers} debitNo={debitNo} dateStr={dateStr} destOrigin={shipPrefix(shipId)} hawb={hawb}
      packages={packages} grossWeight={grossWeight} volumeWeight={netWeight} chargeWeight={chargeWeight}
      ratePerKg={Number(ratePerKg) || 0} feePerBox={Number(feePerBox) || 0}
    />
  );

  async function download() {
    setDownloading(true);
    try {
      const blob = await pdf(docEl).toBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `CnShipping-${(debitNo || shipId).replace(/[\\/:*?"<>|\s]/g, '_')}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } finally { setDownloading(false); }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(360px, 440px) 1fr', gap: 16, padding: 16, alignItems: 'start', maxWidth: 1100, width: '100%', margin: '0 auto' }}>
      <div>
        <div style={box}>
          <label style={lbl}>Shipment (ship-id)</label>
          <select style={inp} value={shipId} onChange={(e) => setShipId(e.target.value)}>
            <option value="">— pick a shipment —</option>
            {shipments.map((s) => <option key={s.shipId} value={s.shipId}>{s.shipId}{s.tracking ? ` · ${s.tracking}` : ''}</option>)}
          </select>
          <div style={{ fontSize: 11, color: '#888', marginTop: 8 }}>Dest/Origin <b>{shipPrefix(shipId) || '—'}</b> · PCS <b>{packages}</b> · GW <b>{grossWeight}</b> · charge <b>{chargeWeight}</b> kg (from Packing List).</div>
        </div>

        <div style={box}>
          <label style={lbl}>Messers (同盈)</label>
          <input style={inp} value={messers} onChange={(e) => setMessers(e.target.value)} placeholder="optional" />
          <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
            <div style={{ flex: 1 }}><label style={lbl}>Debit note no</label><input style={inp} value={debitNo} onChange={(e) => setDebitNo(e.target.value)} placeholder="GZ…" /></div>
            <div style={{ width: 140 }}><label style={lbl}>Date</label><input style={inp} value={dateStr} onChange={(e) => setDateStr(e.target.value)} placeholder="yyyy.mm.dd" /></div>
          </div>
          <label style={{ ...lbl, marginTop: 10 }}>HAWB no</label>
          <input style={inp} value={hawb} onChange={(e) => { setHawb(e.target.value); setHawbTouched(true); }} placeholder="import tracking" />
        </div>

        <div style={box}>
          <label style={lbl}>Charges (RMB)</label>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}><label style={lbl}>运费 rate / kg</label><input style={inp} inputMode="decimal" value={ratePerKg} onChange={(e) => setRatePerKg(e.target.value)} /></div>
            <div style={{ flex: 1 }}><label style={lbl}>报关费 fee / box</label><input style={inp} inputMode="decimal" value={feePerBox} onChange={(e) => setFeePerBox(e.target.value)} /></div>
          </div>
          <div style={{ fontSize: 11, color: '#888', marginTop: 8 }}>Freight = rate × charge weight ({chargeWeight}); customs = fee × packages ({packages}).</div>
        </div>
      </div>

      <div style={{ position: 'sticky', top: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8, gap: 10 }}>
          <div style={{ fontWeight: 700 }}>Preview</div>
          <button type="button" onClick={download} disabled={!ready || downloading} style={{ marginLeft: 'auto', padding: '7px 14px', borderRadius: 6, border: 'none', background: ready ? '#724F33' : '#bbb', color: '#fff', fontWeight: 700, cursor: ready ? 'pointer' : 'default' }}>{downloading ? 'Generating…' : 'Download PDF'}</button>
        </div>
        <div style={{ height: 820, border: '1px solid #d8d8d6', borderRadius: 8, overflow: 'hidden', background: '#f4f4f2' }}>
          {ready ? <PDFViewer width="100%" height="100%" showToolbar={false}>{docEl}</PDFViewer> : (
            <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 14, textAlign: 'center', padding: 20 }}>Pick a shipment and enter a rate/kg or fee/box.</div>
          )}
        </div>
      </div>
    </div>
  );
}
