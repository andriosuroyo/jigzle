'use client';

// JZ-001 — the Orders pipeline window. One sell-side window that presents the order lifecycle as
// pipeline tabs (Pending → Fulfill → Outbound → History), each with a live count badge, plus a
// persistent "+ New order" button. Every panel is an EXISTING stage board mounted in `embedded` mode
// (this shell owns the AppHeader + tab bar; the boards render only their inner two-pane content). All
// four stay mounted so switching tabs keeps each board's selection + scroll; inactive ones are just
// `hidden`. Stage logic is untouched — the boards still call the same RPCs.

import { useCallback, useEffect, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import PendingBoard from '@/components/PendingBoard';
import FulfillBoard from '@/components/FulfillBoard';
import OutboundBoard from '@/components/OutboundBoard';
import HistoryBoard from '@/components/HistoryBoard';
import OrderEntry from '@/components/OrderEntry';
import type { PendingOrder } from '@/app/pending/types';
import type { ToSendQueueRow } from '@/app/fulfill/types';
import type { ShipQueueRow } from '@jigzle/db/types';
import type { HistoryRow } from '@/app/history/types';
import type { PaymentMethod, CourierService, BoxPreset } from '@/app/settings/types';

export type OrdersTab = 'pending' | 'fulfill' | 'outbound' | 'history';
const TABS: { key: OrdersTab; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'fulfill', label: 'Fulfill' },
  { key: 'outbound', label: 'Outbound' },
  { key: 'history', label: 'History' },
];

export default function OrdersShell({
  userEmail,
  initialTab,
  initialOrderId,
  pending,
  toSend,
  ship,
  history,
  paymentMethods,
  courierServices,
  boxPresets,
}: {
  userEmail: string;
  initialTab: OrdersTab;
  initialOrderId: string | null;
  pending: PendingOrder[];
  toSend: ToSendQueueRow[];
  ship: ShipQueueRow[];
  history: HistoryRow[];
  paymentMethods: PaymentMethod[];
  courierServices: CourierService[];
  boxPresets: BoxPreset[];
}) {
  const [tab, setTab] = useState<OrdersTab>(initialTab);
  const [counts, setCounts] = useState<Record<OrdersTab, number>>({
    pending: pending.length,
    fulfill: toSend.length,
    outbound: ship.length,
    history: history.length,
  });
  const [toast, setToast] = useState<{ key: number; msg: string } | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const toastSeq = useRef(0);

  // Stable per-tab count setters (boards report their list size up via onCountChange). Stable identity
  // keeps the boards' reporting effect from re-firing on every shell render.
  const onPendingCount = useCallback((n: number) => setCounts((c) => (c.pending === n ? c : { ...c, pending: n })), []);
  const onFulfillCount = useCallback((n: number) => setCounts((c) => (c.fulfill === n ? c : { ...c, fulfill: n })), []);
  const onOutboundCount = useCallback((n: number) => setCounts((c) => (c.outbound === n ? c : { ...c, outbound: n })), []);
  const onHistoryCount = useCallback((n: number) => setCounts((c) => (c.history === n ? c : { ...c, history: n })), []);

  const showToast = useCallback((msg: string) => {
    setToast({ key: ++toastSeq.current, msg });
  }, []);
  // Auto-dismiss. NB: no auto tab-switch on advance (jarring on mobile) — the toast is the only signal.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const onAdvance = useCallback(
    (salesId: string, toStage: string) => showToast(`Order ${salesId} → ${toStage}.`),
    [showToast]
  );

  const onNewSaved = useCallback(
    (salesId: string, routed: 'fulfill' | 'pending') => {
      setReloadKey((k) => k + 1); // pull the new order into the Pending/Fulfill lists + refresh counts
      showToast(`Order ${salesId} → ${routed === 'fulfill' ? 'Fulfill' : 'Pending'}.`);
    },
    [showToast]
  );

  const fmtCount = (k: OrdersTab) => {
    const n = counts[k];
    // History is capped at 200 rows server-side — show 200+ so the badge doesn't imply a hard total.
    return k === 'history' && n >= 200 ? '200+' : String(n);
  };

  return (
    <div className="ops">
      <AppHeader active="orders" userEmail={userEmail} />

      {/* Pipeline bar — tabs (with live count badges) on the left, the persistent "+ New order" on the
          right. New is a button, not a tab: it's a creation form, not a work-queue. */}
      <div className="orders-bar">
        <nav className="orders-tabs" role="tablist" aria-label="Order pipeline">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`orders-tab ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              <span className="orders-tab-count">{fmtCount(t.key)}</span>
            </button>
          ))}
        </nav>
        <button className="orders-new" onClick={() => setShowNew(true)}>+ New order</button>
      </div>

      {toast && (
        <div className="orders-toast" role="status" aria-live="polite" key={toast.key}>
          {toast.msg}
        </div>
      )}

      {/* All four boards stay mounted; inactive ones are hidden so selection + scroll survive a switch. */}
      <div className="orders-panels">
        <div hidden={tab !== 'pending'}>
          <PendingBoard
            embedded
            initialOrders={pending}
            paymentMethods={paymentMethods}
            userEmail={userEmail}
            onCountChange={onPendingCount}
            onAdvance={onAdvance}
            reloadKey={reloadKey}
          />
        </div>
        <div hidden={tab !== 'fulfill'}>
          <FulfillBoard
            embedded
            initialQueue={toSend}
            courierServices={courierServices}
            initialOrderId={initialTab === 'fulfill' ? initialOrderId : null}
            userEmail={userEmail}
            onCountChange={onFulfillCount}
            onAdvance={onAdvance}
            reloadKey={reloadKey}
          />
        </div>
        <div hidden={tab !== 'outbound'}>
          <OutboundBoard
            embedded
            initialQueue={ship}
            boxPresets={boxPresets}
            initialOrderId={initialTab === 'outbound' ? initialOrderId : null}
            userEmail={userEmail}
            onCountChange={onOutboundCount}
            onAdvance={onAdvance}
            reloadKey={reloadKey}
          />
        </div>
        <div hidden={tab !== 'history'}>
          <HistoryBoard
            embedded
            initialOrders={history}
            paymentMethods={paymentMethods}
            userEmail={userEmail}
            onCountChange={onHistoryCount}
            reloadKey={reloadKey}
          />
        </div>
      </div>

      {/* "+ New order" → the existing create-order flow, layered over the window. On save the order
          lands in Pending (or Fulfill if it cuts at save); the shell toasts + refreshes the counts. */}
      {showNew && (
        <div className="orders-overlay" role="dialog" aria-modal="true" aria-label="New order">
          <div className="orders-overlay-bar">
            <span className="orders-overlay-title">+ New order</span>
            <button className="orders-overlay-close" onClick={() => setShowNew(false)} aria-label="Close">
              ×
            </button>
          </div>
          <div className="orders-overlay-body">
            <OrderEntry embedded userEmail={userEmail} paymentMethods={paymentMethods} onSaved={onNewSaved} />
          </div>
        </div>
      )}
    </div>
  );
}
