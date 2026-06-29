'use client';

// Purchasing window: four tabs — To buy, To forwarder, To ship, History. Mirrors the Outbound/Inbound
// shells. Step 1 re-buckets today's open-PO statuses into To forwarder (Processing + On the way) and
// To ship (With Forwarder) via the existing OrderBoard, and adds read-only To buy (preorder) and
// History (per shipment / per item) views. The full pipeline still works inside the bucketed boards.

import { useMemo, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import OrderBoard from '@/components/OrderBoard';
import ToBuyBoard from '@/components/ToBuyBoard';
import PurchasingHistoryBoard from '@/components/PurchasingHistoryBoard';
import type { Forwarder, OpenPORow, POOpenStatus, Supplier } from '@jigzle/db/types';
import type { OpenShipmentRow, PlannedItemRow, PreorderRow, ReceivedItemRow, ShipmentHistoryRow, SoldOutRow } from '@/app/purchasing/types';

type PurchasingTab = 'tobuy' | 'forwarder' | 'ship' | 'history';
const TAB_LABELS: Record<PurchasingTab, string> = { tobuy: 'To buy', forwarder: 'To forwarder', ship: 'To ship', history: 'History' };

const FORWARDER_STATUSES: POOpenStatus[] = ['Processing', 'On the way'];

export default function PurchasingShell({
  initialQueue,
  suppliers,
  forwarders,
  shipments,
  planned,
  preorders,
  soldOut,
  receivedItems,
  shipmentHistory,
  userEmail,
}: {
  initialQueue: OpenPORow[];
  suppliers: Supplier[];
  forwarders: Forwarder[];
  shipments: OpenShipmentRow[];
  planned: PlannedItemRow[];
  preorders: PreorderRow[];
  soldOut: SoldOutRow[];
  receivedItems: ReceivedItemRow[];
  shipmentHistory: ShipmentHistoryRow[];
  userEmail: string;
}) {
  const [tab, setTab] = useState<PurchasingTab>('forwarder');

  // tab badges from the initial server load (static for step 1; refreshes on reload)
  const forwarderCount = useMemo(() => initialQueue.filter((p) => FORWARDER_STATUSES.includes(p.status as POOpenStatus)).length, [initialQueue]);
  const shipCount = useMemo(() => initialQueue.filter((p) => p.status === 'With Forwarder').length, [initialQueue]);

  return (
    <div className="ops">
      <AppHeader active="purchasing" userEmail={userEmail} />
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Purchasing', href: '/purchasing' }, { label: TAB_LABELS[tab] }]} />

      <div className="orders-bar">
        <nav className="orders-tabs" role="tablist" aria-label="Purchasing">
          <button role="tab" aria-selected={tab === 'tobuy'} className={`orders-tab ${tab === 'tobuy' ? 'active' : ''}`} onClick={() => setTab('tobuy')}>
            To buy<span className="orders-tab-count">{planned.length + preorders.length}</span>
          </button>
          <button role="tab" aria-selected={tab === 'forwarder'} className={`orders-tab ${tab === 'forwarder' ? 'active' : ''}`} onClick={() => setTab('forwarder')}>
            To forwarder<span className="orders-tab-count">{forwarderCount}</span>
          </button>
          <button role="tab" aria-selected={tab === 'ship'} className={`orders-tab ${tab === 'ship' ? 'active' : ''}`} onClick={() => setTab('ship')}>
            To ship<span className="orders-tab-count">{shipCount}</span>
          </button>
          <button role="tab" aria-selected={tab === 'history'} className={`orders-tab ${tab === 'history' ? 'active' : ''}`} onClick={() => setTab('history')}>
            History
          </button>
        </nav>
      </div>

      <div className="orders-panels">
        {tab === 'tobuy' && <ToBuyBoard planned={planned} preorders={preorders} soldOut={soldOut} />}
        {tab === 'forwarder' && (
          <OrderBoard
            embedded
            bucket="forwarder"
            initialQueue={initialQueue}
            suppliers={suppliers}
            forwarders={forwarders}
            shipments={shipments}
            userEmail={userEmail}
          />
        )}
        {tab === 'ship' && (
          <OrderBoard
            embedded
            bucket="ship"
            initialQueue={initialQueue}
            suppliers={suppliers}
            forwarders={forwarders}
            shipments={shipments}
            userEmail={userEmail}
          />
        )}
        {tab === 'history' && <PurchasingHistoryBoard initialItems={receivedItems} initialShipments={shipmentHistory} />}
      </div>
    </div>
  );
}
