'use client';

// Inbound window: two tabs — Shipments (the live arrivals queue, with a count badge) and History
// (shipments we've received). Mirrors the Outbound shell: both boards stay mounted, the inactive one
// hidden, so switching tabs keeps selection + scroll. The boards own their own search.

import { useCallback, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import InboundBoard from '@/components/InboundBoard';
import InboundHistoryBoard from '@/components/InboundHistoryBoard';
import StaffPicker from '@/components/StaffPicker';
import type { ReceiveQueueRow } from '@jigzle/db/types';
import type { InboundHistoryRow } from '@/app/inbound/types';
import type { InboundLabel, StaffMember } from '@/app/settings/types';

type InboundTab = 'arrivals' | 'history';
const TAB_LABELS: Record<InboundTab, string> = { arrivals: 'Shipments', history: 'History' };

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
  const [historyCount, setHistoryCount] = useState(historyRows.length);
  const [adhocSignal, setAdhocSignal] = useState(0);
  const onArrivalsCount = useCallback((n: number) => setArrivalsCount(n), []);
  const onHistoryCount = useCallback((n: number) => setHistoryCount(n), []);

  // "+ Unmarked shipment" (moved out of the queue list): jump to the Shipments tab and fire an ad-hoc receive.
  function startUnmarked() {
    setTab('arrivals');
    setAdhocSignal((n) => n + 1);
  }

  return (
    <div className="ops">
      <AppHeader active="inbound" userEmail={userEmail} />
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Inbound', href: '/inbound' }, { label: TAB_LABELS[tab] }]} />

      {/* Sales-Pending-style underline tabs (Shipments / History) with live counts. */}
      <div className="orders-bar">
        <nav className="fq-filters" role="tablist" aria-label="Inbound">
          <button
            role="tab"
            aria-selected={tab === 'arrivals'}
            className={`fq-filter ${tab === 'arrivals' ? 'active' : ''}`}
            onClick={() => setTab('arrivals')}
          >
            Shipments<span className="fq-filter-count">{arrivalsCount}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === 'history'}
            className={`fq-filter ${tab === 'history' ? 'active' : ''}`}
            onClick={() => setTab('history')}
          >
            History<span className="fq-filter-count">{historyCount}</span>
          </button>
        </nav>
      </div>

      {/* Staff picker + Unmarked-shipment button share one line. */}
      <div className="inbound-actions">
        {staffOptions.length > 0 && <StaffPicker options={staffOptions} />}
        <button className="orders-new" onClick={startUnmarked}>+ Unmarked shipment</button>
      </div>

      <div className="orders-panels">
        <div hidden={tab !== 'arrivals'}>
          <InboundBoard
            embedded
            initialQueue={initialQueue}
            inboundLabels={inboundLabels}
            userEmail={userEmail}
            onCountChange={onArrivalsCount}
            adhocSignal={adhocSignal}
          />
        </div>
        <div hidden={tab !== 'history'}>
          <InboundHistoryBoard initialRows={historyRows} onCountChange={onHistoryCount} />
        </div>
      </div>
    </div>
  );
}
