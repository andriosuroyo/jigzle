'use client';

// Doc Generator (PR202). Tabbed document builder under Tools & Settings. Phase 1 ships the IDR + USD
// invoices; the China docs (Packing List / Invoice / Shipping) and SP Declare are stubbed pending
// Phases 2–3. Each doc renders a live PDF preview with a one-click download (@react-pdf/renderer).

import { useEffect, useState } from 'react';
import { useUrlTab } from '@/components/useUrlTab';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import InvoiceTab from '@/components/docs/InvoiceTab';
import CnPackingTab, { emptyBox } from '@/components/docs/CnPackingTab';
import CnInvoiceTab from '@/components/docs/CnInvoiceTab';
import CnShippingTab from '@/components/docs/CnShippingTab';
import SpDeclareTab from '@/components/docs/SpDeclareTab';
import { getShipments } from '@/app/doc-generator/actions';
import { getCnAddresses } from '@/app/settings/actions';
import type { CnBox, CnShipmentRow } from '@/app/doc-generator/types';
import type { CnAddress } from '@/app/settings/types';

type Tab = 'invoice-idr' | 'invoice-usd' | 'cn-packing' | 'cn-invoice' | 'cn-shipping' | 'sp-declare';
const TABS: { key: Tab; label: string }[] = [
  { key: 'invoice-idr', label: 'Invoice IDR' },
  { key: 'invoice-usd', label: 'Invoice USD' },
  { key: 'cn-packing', label: 'CN Packing List' },
  { key: 'cn-invoice', label: 'CN Invoice' },
  { key: 'cn-shipping', label: 'CN Shipping' },
  { key: 'sp-declare', label: 'SP Declare' },
];

export default function DocGeneratorBoard({ userEmail }: { userEmail: string }) {
  // PR223 — the active tab is mirrored to ?tab= so the breadcrumb Refresh (a hard reload) stays put.
  const [tab, setTab] = useUrlTab<Tab>('tab', 'invoice-idr', ['invoice-idr', 'invoice-usd', 'cn-packing', 'cn-invoice', 'cn-shipping', 'sp-declare']);
  const label = TABS.find((t) => t.key === tab)!.label;

  // ── shared CN state (a picked shipment + its packages feed all three China docs) ──
  const [shipments, setShipments] = useState<CnShipmentRow[]>([]);
  const [cnAddresses, setCnAddresses] = useState<CnAddress[]>([]); // PR356 — Settings-managed address list
  const [shipmentsLoaded, setShipmentsLoaded] = useState(false);
  const [cnShipId, setCnShipId] = useState('');
  const [cnMark, setCnMark] = useState('');
  const [cnBoxes, setCnBoxes] = useState<CnBox[]>([emptyBox()]);
  const [cnBoxTracking, setCnBoxTracking] = useState(''); // PR354 — comma-separated box trackings (Packing List)
  const [cnDivisor, setCnDivisor] = useState(6000);

  const isCn = tab === 'cn-packing' || tab === 'cn-invoice' || tab === 'cn-shipping';
  useEffect(() => {
    if (isCn && !shipmentsLoaded) {
      setShipmentsLoaded(true);
      getShipments().then(setShipments).catch(() => setShipments([]));
      getCnAddresses().then(setCnAddresses).catch(() => setCnAddresses([]));
    }
  }, [isCn, shipmentsLoaded]);

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
        {tab === 'invoice-idr' && <InvoiceTab currency="IDR" />}
        {tab === 'invoice-usd' && <InvoiceTab currency="USD" />}
        {tab === 'cn-packing' && (
          <CnPackingTab
            shipments={shipments}
            shipId={cnShipId} setShipId={setCnShipId}
            mark={cnMark} setMark={setCnMark}
            boxes={cnBoxes} setBoxes={setCnBoxes}
            boxTracking={cnBoxTracking} setBoxTracking={setCnBoxTracking}
            divisor={cnDivisor} setDivisor={setCnDivisor}
          />
        )}
        {tab === 'cn-invoice' && (
          <CnInvoiceTab shipments={shipments} addresses={cnAddresses} shipId={cnShipId} setShipId={setCnShipId} mark={cnMark} boxes={cnBoxes} divisor={cnDivisor} />
        )}
        {tab === 'cn-shipping' && (
          <CnShippingTab shipments={shipments} shipId={cnShipId} setShipId={setCnShipId} boxes={cnBoxes} divisor={cnDivisor} />
        )}
        {tab === 'sp-declare' && <SpDeclareTab />}
      </div>
    </div>
  );
}
