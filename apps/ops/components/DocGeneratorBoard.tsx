'use client';

// Doc Generator (PR202). Tabbed document builder under Tools & Settings. Phase 1 ships the IDR + USD
// invoices; the China docs (Packing List / Invoice / Shipping) and SP Declare are stubbed pending
// Phases 2–3. Each doc renders a live PDF preview with a one-click download (@react-pdf/renderer).

import { useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import InvoiceTab from '@/components/docs/InvoiceTab';

type Tab = 'invoice-idr' | 'invoice-usd' | 'cn-packing' | 'cn-invoice' | 'cn-shipping' | 'sp-declare';
const TABS: { key: Tab; label: string }[] = [
  { key: 'invoice-idr', label: 'Invoice IDR' },
  { key: 'invoice-usd', label: 'Invoice USD' },
  { key: 'cn-packing', label: 'CN Packing List' },
  { key: 'cn-invoice', label: 'CN Invoice' },
  { key: 'cn-shipping', label: 'CN Shipping' },
  { key: 'sp-declare', label: 'SP Declare' },
];

function ComingSoon({ label }: { label: string }) {
  return (
    <div style={{ padding: 40, color: '#888', fontSize: 14 }}>
      <b>{label}</b> is coming in a later phase.
    </div>
  );
}

export default function DocGeneratorBoard({ userEmail }: { userEmail: string }) {
  const [tab, setTab] = useState<Tab>('invoice-idr');
  const label = TABS.find((t) => t.key === tab)!.label;

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
        {tab === 'cn-packing' && <ComingSoon label="CN Packing List" />}
        {tab === 'cn-invoice' && <ComingSoon label="CN Invoice" />}
        {tab === 'cn-shipping' && <ComingSoon label="CN Shipping" />}
        {tab === 'sp-declare' && <ComingSoon label="SP Declare" />}
      </div>
    </div>
  );
}
