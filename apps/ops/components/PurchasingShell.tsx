'use client';

// Purchasing window: four tabs — To buy, To forwarder, To ship, History. Mirrors the Outbound/Inbound
// shells. Step 1 re-buckets today's open-PO statuses into To forwarder (Processing + On the way) and
// To ship (With Forwarder) via the existing OrderBoard, and adds read-only To buy (preorder) and
// History (per shipment / per item) views. The full pipeline still works inside the bucketed boards.

import { useMemo, useState } from 'react';
import { useUrlTab } from '@/components/useUrlTab';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import OrderBoard from '@/components/OrderBoard';
import ToBuyBoard from '@/components/ToBuyBoard';
import PurchasingHistoryBoard from '@/components/PurchasingHistoryBoard';
import type { Forwarder, OpenPORow, POOpenStatus, Supplier } from '@jigzle/db/types';
import type { OpenShipmentRow, PlannedItemRow, PreorderRow, ShipmentHistoryRow, SoldOutRow } from '@/app/purchasing/types';

type PurchasingTab = 'tobuy' | 'forwarder' | 'ship' | 'history';
// PR267 — tab labels renamed Buy / Forward / Ship (internal keys unchanged, so URLs/?tab= are stable).
const TAB_LABELS: Record<PurchasingTab, string> = { tobuy: 'Buy', forwarder: 'Forward', ship: 'Ship', history: 'History' };

const FORWARDER_STATUSES: POOpenStatus[] = ['Processing', 'On the way'];

export default function PurchasingShell({
  initialQueue,
  suppliers,
  forwarders,
  shipments,
  planned,
  preorders,
  soldOut,
  shipmentHistory,
  localCouriers = [],
  shipmentCouriers = [],
  userEmail,
}: {
  initialQueue: OpenPORow[];
  suppliers: Supplier[];
  forwarders: Forwarder[];
  shipments: OpenShipmentRow[];
  planned: PlannedItemRow[];
  preorders: PreorderRow[];
  soldOut: SoldOutRow[];
  shipmentHistory: ShipmentHistoryRow[];
  localCouriers?: string[]; // 0055 — To-forwarder's local-courier suggestions (Settings-managed)
  shipmentCouriers?: string[]; // 0056 — History's international courier pick-list (Settings-managed)
  userEmail: string;
}) {
  // PR229 — default to "To buy"; PR223 mirrors the active tab to ?tab= so Refresh (a hard reload) stays put.
  const [tab, setTab] = useUrlTab<PurchasingTab>('tab', 'tobuy', ['tobuy', 'forwarder', 'ship', 'history']);
  // PR153: a board's bodyview DETAIL is open → hide the pipeline tabs (the breadcrumb stays) for
  // more viewing space. Boards report via onDetailOpenChange; a tab switch always resets it.
  const [detailOpen, setDetailOpen] = useState(false);
  function switchTab(t: PurchasingTab) { setDetailOpen(false); setTab(t); }
  // PR263 — "Batch confirm" (To forwarder) and "Create shipment ID" (To ship) are now entry buttons
  // at the top of each board's list (like To-buy's "add item"), so the shell no longer hosts them.

  // tab badges from the initial server load (static for step 1; refreshes on reload)
  const forwarderCount = useMemo(() => initialQueue.filter((p) => FORWARDER_STATUSES.includes(p.status as POOpenStatus)).length, [initialQueue]);
  // PR163: To ship counts only ungrouped POs — once grouped into a shipment (ship_id set) a PO moves to
  // History → Active, so it leaves the To-ship queue (matches OrderBoard's `shown` filter).
  const shipCount = useMemo(() => initialQueue.filter((p) => p.status === 'With Forwarder' && !p.ship_id).length, [initialQueue]);

  return (
    <div className="ops">
      <AppHeader active="purchasing" userEmail={userEmail} />
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Purchasing', href: '/purchasing' }, { label: TAB_LABELS[tab] }]} />

      {!detailOpen && (
      <div className="orders-bar">
        <nav className="orders-tabs" role="tablist" aria-label="Purchasing">
          <button role="tab" aria-selected={tab === 'tobuy'} className={`orders-tab ${tab === 'tobuy' ? 'active' : ''}`} onClick={() => switchTab('tobuy')}>
            Buy<span className="orders-tab-count">{planned.length + preorders.length}</span>
          </button>
          <button role="tab" aria-selected={tab === 'forwarder'} className={`orders-tab ${tab === 'forwarder' ? 'active' : ''}`} onClick={() => switchTab('forwarder')}>
            Forward<span className="orders-tab-count">{forwarderCount}</span>
          </button>
          <button role="tab" aria-selected={tab === 'ship'} className={`orders-tab ${tab === 'ship' ? 'active' : ''}`} onClick={() => switchTab('ship')}>
            Ship<span className="orders-tab-count">{shipCount}</span>
          </button>
          <button role="tab" aria-selected={tab === 'history'} className={`orders-tab ${tab === 'history' ? 'active' : ''}`} onClick={() => switchTab('history')}>
            History
          </button>
        </nav>
      </div>
      )}

      {/* PR167 — keep every board MOUNTED (hidden when inactive), like the Sales/Outbound shells. With
          the old `{tab === x && <Board/>}` a tab switch unmounted the board and re-mounted it from these
          stale page-load props, so a just-deleted item re-appeared until a full reload. Staying mounted
          preserves each board's own post-delete state across tab switches. */}
      <div className="orders-panels">
        <div hidden={tab !== 'tobuy'}>
          <ToBuyBoard planned={planned} preorders={preorders} soldOut={soldOut} suppliers={suppliers} />
        </div>
        <div hidden={tab !== 'forwarder'}>
          <OrderBoard
            embedded
            bucket="forwarder"
            initialQueue={initialQueue}
            suppliers={suppliers}
            forwarders={forwarders}
            shipments={shipments}
            localCouriers={localCouriers}
            onDetailOpenChange={setDetailOpen}
            userEmail={userEmail}
          />
        </div>
        <div hidden={tab !== 'ship'}>
          <OrderBoard
            embedded
            bucket="ship"
            initialQueue={initialQueue}
            suppliers={suppliers}
            forwarders={forwarders}
            shipments={shipments}
            localCouriers={localCouriers}
            onDetailOpenChange={setDetailOpen}
            userEmail={userEmail}
          />
        </div>
        <div hidden={tab !== 'history'}>
          <PurchasingHistoryBoard active={tab === 'history'} initialShipments={shipmentHistory} shipmentCouriers={shipmentCouriers} suppliers={suppliers} localCouriers={localCouriers} onDetailOpenChange={setDetailOpen} />
        </div>
      </div>
    </div>
  );
}
