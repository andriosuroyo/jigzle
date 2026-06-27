'use client';

// Inbound window: two tabs — Shipments (the live arrivals queue, with a count badge) and History
// (shipments we've received). Mirrors the Outbound shell: both boards stay mounted, the inactive one
// hidden, so switching tabs keeps selection + scroll. The boards own their own search.

import { useCallback, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import InboundBoard from '@/components/InboundBoard';
import InboundHistoryBoard from '@/components/InboundHistoryBoard';
import type { ReceiveQueueRow } from '@jigzle/db/types';
import type { InboundHistoryRow } from '@/app/inbound/types';
import type { InboundLabel } from '@/app/settings/types';

type InboundTab = 'arrivals' | 'history';

export default function InboundShell({
  initialQueue,
  inboundLabels,
  historyRows,
  userEmail,
}: {
  initialQueue: ReceiveQueueRow[];
  inboundLabels: InboundLabel[];
  historyRows: InboundHistoryRow[];
  userEmail: string;
}) {
  const [tab, setTab] = useState<InboundTab>('arrivals');
  const [arrivalsCount, setArrivalsCount] = useState(initialQueue.length);
  const onArrivalsCount = useCallback((n: number) => setArrivalsCount(n), []);

  return (
    <div className="ops">
      <AppHeader active="inbound" userEmail={userEmail} />

      <div className="orders-bar">
        <nav className="orders-tabs" role="tablist" aria-label="Inbound">
          <button
            role="tab"
            aria-selected={tab === 'arrivals'}
            className={`orders-tab ${tab === 'arrivals' ? 'active' : ''}`}
            onClick={() => setTab('arrivals')}
          >
            Shipments<span className="orders-tab-count">{arrivalsCount}</span>
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
      </div>

      <div className="orders-panels">
        <div hidden={tab !== 'arrivals'}>
          <InboundBoard
            embedded
            initialQueue={initialQueue}
            inboundLabels={inboundLabels}
            userEmail={userEmail}
            onCountChange={onArrivalsCount}
          />
        </div>
        <div hidden={tab !== 'history'}>
          <InboundHistoryBoard initialRows={historyRows} />
        </div>
      </div>
    </div>
  );
}
