'use client';

// Outbound window: two tabs — Ready to ship (the live queue, with a count badge) and History (orders
// we've shipped). Mirrors the Sales window shell: both boards stay mounted, inactive one hidden, so
// switching tabs keeps selection + scroll. The boards own their own search.

import { useCallback, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import OutboundBoard from '@/components/OutboundBoard';
import OutboundHistoryBoard from '@/components/OutboundHistoryBoard';
import type { ShipQueueRow } from '@jigzle/db/types';
import type { ShippedOrderRow } from '@/app/outbound/types';
import type { BoxPreset } from '@/app/settings/types';

type OutboundTab = 'ready' | 'history';

export default function OutboundShell({
  userEmail,
  initialQueue,
  boxPresets,
  shippedHistory,
  initialOrderId,
}: {
  userEmail: string;
  initialQueue: ShipQueueRow[];
  boxPresets: BoxPreset[];
  shippedHistory: ShippedOrderRow[];
  initialOrderId: string | null;
}) {
  const [tab, setTab] = useState<OutboundTab>('ready');
  const [readyCount, setReadyCount] = useState(initialQueue.length);
  const onReadyCount = useCallback((n: number) => setReadyCount(n), []);

  return (
    <div className="ops">
      <AppHeader active="outbound" userEmail={userEmail} />

      <div className="orders-bar">
        <nav className="orders-tabs" role="tablist" aria-label="Outbound">
          <button
            role="tab"
            aria-selected={tab === 'ready'}
            className={`orders-tab ${tab === 'ready' ? 'active' : ''}`}
            onClick={() => setTab('ready')}
          >
            Ready to ship<span className="orders-tab-count">{readyCount}</span>
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
        <div hidden={tab !== 'ready'}>
          <OutboundBoard
            embedded
            initialQueue={initialQueue}
            boxPresets={boxPresets}
            initialOrderId={initialOrderId}
            userEmail={userEmail}
            onCountChange={onReadyCount}
          />
        </div>
        <div hidden={tab !== 'history'}>
          <OutboundHistoryBoard initialOrders={shippedHistory} boxPresets={boxPresets} />
        </div>
      </div>
    </div>
  );
}
