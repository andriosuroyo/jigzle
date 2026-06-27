'use client';

// JZ-001 — the Sales pipeline window. One sell-side window that presents the order lifecycle as
// pipeline tabs (Pending → Fulfill → History), plus a persistent "+ New order" button. Pending and
// Fulfill carry a live count badge (work-queues to clear); History is a read-only log, so no badge.
// Outbound is NOT here — the Sales team's job stops at Fulfill; shipping is a separate (warehouse)
// screen. Every panel is an EXISTING stage board mounted in `embedded` mode (this shell owns the
// AppHeader + tab bar; the boards render only their inner two-pane content). All three stay mounted so
// switching tabs keeps each board's selection + scroll; inactive ones are just `hidden`. Stage logic
// is untouched — the boards still call the same RPCs.

import { useCallback, useEffect, useRef, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import PendingBoard from '@/components/PendingBoard';
import FulfillBoard from '@/components/FulfillBoard';
import HistoryBoard from '@/components/HistoryBoard';
import OrderEntry from '@/components/OrderEntry';
import type { PendingOrder } from '@/app/pending/types';
import type { ToSendQueueRow } from '@/app/fulfill/types';
import type { HistoryRow } from '@/app/history/types';
import type { PaymentMethod, CourierService, BoxPreset, CommonNote } from '@/app/settings/types';

export type OrdersTab = 'pending' | 'fulfill' | 'history';
// `badge: false` → a read-only log (History) shows no count; only the work-queues do.
const TABS: { key: OrdersTab; label: string; badge: boolean }[] = [
  { key: 'pending', label: 'Pending', badge: true },
  { key: 'fulfill', label: 'Fulfill', badge: true },
  { key: 'history', label: 'History', badge: false },
];

export default function OrdersShell({
  userEmail,
  initialTab,
  initialOrderId,
  pending,
  toSend,
  history,
  paymentMethods,
  courierServices,
  boxPresets,
  commonNotes,
}: {
  userEmail: string;
  initialTab: OrdersTab;
  initialOrderId: string | null;
  pending: PendingOrder[];
  toSend: ToSendQueueRow[];
  history: HistoryRow[];
  paymentMethods: PaymentMethod[];
  courierServices: CourierService[];
  boxPresets: BoxPreset[];
  commonNotes: CommonNote[];
}) {
  const [tab, setTab] = useState<OrdersTab>(initialTab);
  const [counts, setCounts] = useState<{ pending: number; fulfill: number }>({
    pending: pending.length,
    fulfill: toSend.length,
  });
  const [toast, setToast] = useState<{ key: number; msg: string } | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const toastSeq = useRef(0);

  // Stable per-tab count setters (boards report their list size up via onCountChange). Stable identity
  // keeps the boards' reporting effect from re-firing on every shell render.
  const onPendingCount = useCallback((n: number) => setCounts((c) => (c.pending === n ? c : { ...c, pending: n })), []);
  const onFulfillCount = useCallback((n: number) => setCounts((c) => (c.fulfill === n ? c : { ...c, fulfill: n })), []);

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

  return (
    <div className="ops">
      <AppHeader active="orders" userEmail={userEmail} />

      {/* Pipeline bar — tabs (Pending/Fulfill carry a live count badge) on the left, the persistent
          "+ New order" on the right. New is a button, not a tab: it's a creation form, not a queue. */}
      <div className="orders-bar">
        <nav className="orders-tabs" role="tablist" aria-label="Sales pipeline">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={tab === t.key}
              className={`orders-tab ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              {t.badge && <span className="orders-tab-count">{counts[t.key as 'pending' | 'fulfill']}</span>}
            </button>
          ))}
        </nav>
        <button className="orders-new" onClick={() => setShowNew(true)} aria-label="New order">+ New</button>
      </div>

      {toast && (
        <div className="orders-toast" role="status" aria-live="polite" key={toast.key}>
          {toast.msg}
        </div>
      )}

      {/* All three boards stay mounted; inactive ones are hidden so selection + scroll survive a switch. */}
      <div className="orders-panels">
        <div hidden={tab !== 'pending'}>
          <PendingBoard
            embedded
            initialOrders={pending}
            userEmail={userEmail}
            commonNotes={commonNotes}
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
            commonNotes={commonNotes}
            initialOrderId={initialTab === 'fulfill' ? initialOrderId : null}
            userEmail={userEmail}
            onCountChange={onFulfillCount}
            onAdvance={onAdvance}
            reloadKey={reloadKey}
          />
        </div>
        <div hidden={tab !== 'history'}>
          <HistoryBoard
            embedded
            initialOrders={history}
            boxPresets={boxPresets}
            userEmail={userEmail}
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
