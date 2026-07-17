'use client';

// PR359 — a compact, read-only "from Purchasing" card shown beside the CN Packing List / CN Invoice
// shipment pickers. It surfaces the shipment's total item cost, packaging (box dims/weights) and the
// tracking legs so the operator can cross-check the doc against what was saved in Purchasing.

import type { CnShipmentRef } from '@/app/doc-generator/types';

const wrap: React.CSSProperties = { border: '1px solid #e4e0d8', borderRadius: 8, padding: '10px 12px', background: '#faf8f4', fontSize: 12 };
const head: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: '#9b917f', textTransform: 'uppercase', marginBottom: 6 };
const row: React.CSSProperties = { display: 'grid', gridTemplateColumns: '92px 1fr', gap: 8, padding: '2px 0' };
const k: React.CSSProperties = { color: '#9b917f', fontWeight: 600 };
const v: React.CSSProperties = { color: '#3f3a30', wordBreak: 'break-word' };

const r2 = (n: number) => Math.round(n * 100) / 100;

export default function CnShipmentRefPanel({ data, shipId }: { data: CnShipmentRef | null; shipId: string }) {
  if (!shipId) return null;
  if (!data) return <div style={wrap}><div style={head}>From purchasing</div><span style={{ color: '#9b917f' }}>Loading…</span></div>;

  const dims = data.boxes.filter((b) => b.p || b.l || b.t).map((b) => `${b.p ?? '—'}×${b.l ?? '—'}×${b.t ?? '—'}`).join(', ');
  const weights = data.boxes.filter((b) => b.w != null).map((b) => b.w).join(', ');
  const boxTr = [...new Set(data.boxes.map((b) => (b.tracking ?? '').trim()).filter(Boolean))].join(', ');
  const leg = (courier: string | null, tracking: string | null) => [courier?.trim(), tracking?.trim()].filter(Boolean).join(' · ') || '—';

  return (
    <div style={wrap}>
      <div style={head}>From purchasing · {shipId}</div>
      <div style={row}>
        <span style={k}>Item cost</span>
        <span style={v}>{data.totalCost != null ? `${r2(data.totalCost)}${data.currencySymbol}` : '—'}{data.itemLines ? `  ·  ${data.itemLines} item${data.itemLines === 1 ? '' : 's'} / ${data.totalUnits} pcs` : ''}</span>
      </div>
      <div style={row}>
        <span style={k}>Packages</span>
        <span style={v}>{data.boxes.length ? `${data.boxes.length} box${data.boxes.length === 1 ? '' : 'es'}${dims ? ` · ${dims} cm` : ''}${weights ? ` · ${weights} kg` : ''}` : '—'}</span>
      </div>
      <div style={row}><span style={k}>Consolidator</span><span style={v}>{leg(data.consolidatorCourier, data.consolidatorTracking)}</span></div>
      <div style={row}><span style={k}>Shipment</span><span style={v}>{leg(data.shipmentCourier, data.shipmentTracking)}</span></div>
      {boxTr && <div style={row}><span style={k}>Box tracking</span><span style={v}>{boxTr}</span></div>}
    </div>
  );
}
