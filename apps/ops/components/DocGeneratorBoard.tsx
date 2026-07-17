'use client';

// Doc Generator (PR202). Tabbed document builder under Tools & Settings. Phase 1 ships the IDR + USD
// invoices; the China docs (Packing List / Invoice / Shipping) and SP Declare are stubbed pending
// Phases 2–3. Each doc renders a live PDF preview with a one-click download (@react-pdf/renderer).

import { useEffect, useRef, useState } from 'react';
import { useUrlTab } from '@/components/useUrlTab';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import InvoiceTab from '@/components/docs/InvoiceTab';
import CnPackingTab, { emptyBox } from '@/components/docs/CnPackingTab';
import CnInvoiceTab from '@/components/docs/CnInvoiceTab';
import CnShippingTab from '@/components/docs/CnShippingTab';
import SpDeclareTab from '@/components/docs/SpDeclareTab';
import { getShipments, getCnShipmentRef } from '@/app/doc-generator/actions';
import { getShipmentBoxes } from '@/app/purchasing/actions';
import { getCnAddresses } from '@/app/settings/actions';
import type { CnBox, CnShipmentRow, CnShipmentRef } from '@/app/doc-generator/types';
import type { CnAddress } from '@/app/settings/types';

// PR361 — the IDR + USD invoices are one "Customer Invoice" tab now; currency is picked inside it.
type Tab = 'invoice' | 'cn-packing' | 'cn-invoice' | 'cn-shipping' | 'sp-declare';
const TABS: { key: Tab; label: string }[] = [
  { key: 'invoice', label: 'Customer Invoice' },
  { key: 'cn-packing', label: 'CN Packing List' },
  { key: 'cn-invoice', label: 'CN Invoice' },
  { key: 'cn-shipping', label: 'CN Shipping' },
  { key: 'sp-declare', label: 'SP Declare' },
];

export default function DocGeneratorBoard({ userEmail }: { userEmail: string }) {
  // PR223 — the active tab is mirrored to ?tab= so the breadcrumb Refresh (a hard reload) stays put.
  const [tab, setTab] = useUrlTab<Tab>('tab', 'invoice', ['invoice', 'cn-packing', 'cn-invoice', 'cn-shipping', 'sp-declare']);
  const label = TABS.find((t) => t.key === tab)!.label;

  // ── shared CN state (a picked shipment + its packages feed all three China docs) ──
  const [shipments, setShipments] = useState<CnShipmentRow[]>([]);
  const [cnAddresses, setCnAddresses] = useState<CnAddress[]>([]); // PR356 — Settings-managed address list
  const [shipmentsLoaded, setShipmentsLoaded] = useState(false);
  const [cnShipId, setCnShipId] = useState('');
  const [cnMark, setCnMark] = useState('');
  const [cnBoxes, setCnBoxes] = useState<CnBox[]>([emptyBox()]);
  const [cnBoxTracking, setCnBoxTracking] = useState(''); // PR354 — comma-separated box trackings (Packing List)
  const [cnShipRef, setCnShipRef] = useState<CnShipmentRef | null>(null); // PR359 — Purchasing cross-check
  const [cnDivisor, setCnDivisor] = useState(6000);

  const isCn = tab === 'cn-packing' || tab === 'cn-invoice' || tab === 'cn-shipping';
  useEffect(() => {
    if (isCn && !shipmentsLoaded) {
      setShipmentsLoaded(true);
      getShipments().then(setShipments).catch(() => setShipments([]));
      getCnAddresses().then(setCnAddresses).catch(() => setCnAddresses([]));
    }
  }, [isCn, shipmentsLoaded]);

  // PR358 — prefill packages + box tracking from the picked shipment's saved boxes (Purchasing → History)
  // at the BOARD level, so every CN doc (Invoice/Shipping too, not just Packing List) gets the right
  // packages/net/gross. Runs once per ship-id; manual edits made afterwards are preserved.
  const prefilledFor = useRef('');
  useEffect(() => {
    const sid = cnShipId.trim();
    if (!sid) { setCnShipRef(null); return; }
    if (prefilledFor.current === sid) return;
    prefilledFor.current = sid;
    getShipmentBoxes(sid)
      .then((rows) => {
        if (rows.length) {
          setCnBoxes(rows.map((b) => ({ desc: '', p: b.dim_p?.toString() ?? '', l: b.dim_l?.toString() ?? '', t: b.dim_t?.toString() ?? '', realWeight: b.real_weight?.toString() ?? '' })));
          setCnBoxTracking([...new Set(rows.map((b) => (b.tracking ?? '').trim()).filter(Boolean))].join(', '));
        }
      })
      .catch(() => {});
    // PR359 — the read-only Purchasing cross-check (cost / packaging / tracking) for this shipment.
    setCnShipRef(null);
    getCnShipmentRef(sid).then(setCnShipRef).catch(() => setCnShipRef(null));
  }, [cnShipId]);

  return (
    <div className="ops">
      <AppHeader active="doc-generator" userEmail={userEmail} />
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Doc Generator', href: '/doc-generator' }, { label }]} />

      <div className="orders-bar">
        <nav className="orders-tabs" role="tablist" aria-label="Doc Generator">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={`orders-tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="orders-panels">
        {tab === 'invoice' && <InvoiceTab />}
        {tab === 'cn-packing' && (
          <CnPackingTab
            shipments={shipments}
            shipRef={cnShipRef}
            shipId={cnShipId} setShipId={setCnShipId}
            mark={cnMark} setMark={setCnMark}
            boxes={cnBoxes} setBoxes={setCnBoxes}
            boxTracking={cnBoxTracking} setBoxTracking={setCnBoxTracking}
            divisor={cnDivisor} setDivisor={setCnDivisor}
          />
        )}
        {tab === 'cn-invoice' && (
          <CnInvoiceTab shipments={shipments} shipRef={cnShipRef} addresses={cnAddresses} shipId={cnShipId} setShipId={setCnShipId} mark={cnMark} boxes={cnBoxes} divisor={cnDivisor} />
        )}
        {tab === 'cn-shipping' && (
          <CnShippingTab shipments={shipments} shipId={cnShipId} setShipId={setCnShipId} boxes={cnBoxes} divisor={cnDivisor} />
        )}
        {tab === 'sp-declare' && <SpDeclareTab />}
      </div>
    </div>
  );
}
