'use client';

// Inbound window: two tabs — Shipments (the live arrivals queue, with a count badge) and History
// (shipments we've received). Mirrors the Outbound shell: both boards stay mounted, the inactive one
// hidden, so switching tabs keeps selection + scroll. The boards own their own search.

import { useCallback, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import InboundBoard from '@/components/InboundBoard';
import InboundHistoryBoard from '@/components/InboundHistoryBoard';
import type { ReceiveQueueRow } from '@jigzle/db/types';
import type { InboundHistoryRow } from '@/app/inbound/types';
import type { InboundLabel, StaffMember } from '@/app/settings/types';

type InboundTab = 'arrivals' | 'history';
const TAB_LABELS: Record<InboundTab, string> = { arrivals: 'Active', history: 'History' };

export default function InboundShell({
  initialQueue,
  inboundLabels,
  historyRows,
  staffOptions,
  userEmail,
}: {
  initialQueue: ReceiveQueueRow[];
  inboundLabels: InboundLabel[];
  historyRows: InboundHistoryRow[];
  staffOptions: StaffMember[];
  userEmail: string;
}) {
  const [tab, setTab] = useState<InboundTab>('arrivals');
  const [arrivalsCount, setArrivalsCount] = useState(initialQueue.length);
  const [adhocSignal, setAdhocSignal] = useState(0);
  const onArrivalsCount = useCallback((n: number) => setArrivalsCount(n), []);
  // PR154: a board's bodyview DETAIL is open → hide the tab bar (breadcrumb stays). Tracked per tab
  // because both boards stay mounted; the bar hides only when the ACTIVE tab's detail is open.
  const [detailOpenBy, setDetailOpenBy] = useState<Record<InboundTab, boolean>>({ arrivals: false, history: false });
  const onArrivalsDetail = useCallback((open: boolean) => setDetailOpenBy((p) => (p.arrivals === open ? p : { ...p, arrivals: open })), []);
  const onHistoryDetail = useCallback((open: boolean) => setDetailOpenBy((p) => (p.history === open ? p : { ...p, history: open })), []);
  const detailOpen = detailOpenBy[tab];

  // "+ Unmarked shipment" (moved out of the queue list): jump to the Shipments tab and fire an ad-hoc receive.
  function startUnmarked() {
    setTab('arrivals');
    setAdhocSignal((n) => n + 1);
  }

  return (
    <div className="ops">
      <AppHeader active="inbound" userEmail={userEmail} />
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Inbound', href: '/inbound' }, { label: TAB_LABELS[tab] }]} />

      {!detailOpen && (
        <div className="orders-bar">
          <nav className="orders-tabs" role="tablist" aria-label="Inbound">
            <button
              role="tab"
              aria-selected={tab === 'arrivals'}
              className={`orders-tab ${tab === 'arrivals' ? 'active' : ''}`}
              onClick={() => setTab('arrivals')}
            >
              Active<span className="orders-tab-count">{arrivalsCount}</span>
            </button>
            <button
              role="tab"
              aria-selected={tab === 'history'}
              className={`orders-tab ${tab === 'history' ? 'active' : ''}`}
              onClick={() => setTab('history')}
            >
              History
            </button>
          </nav>
          <button className="orders-new" onClick={startUnmarked}>+ Unmarked</button>
        </div>
      )}

      <div className="orders-panels">
        <div hidden={tab !== 'arrivals'}>
          <InboundBoard
            embedded
            initialQueue={initialQueue}
            inboundLabels={inboundLabels}
            staffOptions={staffOptions}
            userEmail={userEmail}
            onCountChange={onArrivalsCount}
            onDetailOpenChange={onArrivalsDetail}
            adhocSignal={adhocSignal}
          />
        </div>
        <div hidden={tab !== 'history'}>
          <InboundHistoryBoard initialRows={historyRows} onDetailOpenChange={onHistoryDetail} />
        </div>
      </div>
    </div>
  );
}
