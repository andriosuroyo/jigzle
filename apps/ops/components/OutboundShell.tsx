'use client';

// Outbound window: two tabs — Ready to ship (the live queue, with a count badge) and History (orders
// we've shipped). Mirrors the Sales window shell: both boards stay mounted, inactive one hidden, so
// switching tabs keeps selection + scroll. The boards own their own search.

import { useCallback, useEffect, useMemo, useState } from 'react';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import OutboundBoard from '@/components/OutboundBoard';
import OutboundHistoryBoard from '@/components/OutboundHistoryBoard';
import { getMonthlyShipmentsXlsx, getShipmentMonthRange } from '@/app/outbound/actions';
import type { ShipQueueRow } from '@jigzle/db/types';
import type { ShipmentHistoryRow } from '@/app/outbound/types';
import type { BoxPreset } from '@/app/settings/types';

type OutboundTab = 'ready' | 'history';
const TAB_LABELS: Record<OutboundTab, string> = { ready: 'Ready to ship', history: 'History' };
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
  shippedHistory: ShipmentHistoryRow[];
  initialOrderId: string | null;
}) {
  const [tab, setTab] = useState<OutboundTab>('ready');
  const [readyCount, setReadyCount] = useState(initialQueue.length);
  const onReadyCount = useCallback((n: number) => setReadyCount(n), []);

  // Monthly report — list the COMPLETED months (current month excluded until it's over), latest first.
  // The span comes from the canonical log's earliest…latest ship_date (loaded when the overlay opens),
  // so every historical month back to 2022 is offered, not just a fixed window.
  const [showReport, setShowReport] = useState(false);
  const [reportBusy, setReportBusy] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [range, setRange] = useState<{ minDate: string; maxDate: string } | null>(null);
  const [rangeLoaded, setRangeLoaded] = useState(false);

  useEffect(() => {
    if (!showReport || rangeLoaded) return;
    let live = true;
    getShipmentMonthRange()
      .then((r) => { if (live) setRange(r); })
      .catch(() => { /* fall back to the default window below */ })
      .finally(() => { if (live) setRangeLoaded(true); });
    return () => { live = false; };
  }, [showReport, rangeLoaded]);

  const months = useMemo(() => {
    const now = new Date();
    // newest completed month = the month before the current one
    let endY = now.getFullYear();
    let endM = now.getMonth() - 1; // 0-indexed
    if (endM < 0) { endM = 11; endY -= 1; }
    // earliest month to offer: the log's first ship month, else a 12-month default window
    let startY: number;
    let startM: number;
    if (range) {
      startY = Number(range.minDate.slice(0, 4));
      startM = Number(range.minDate.slice(5, 7)) - 1;
    } else {
      startY = endY;
      startM = endM - 11;
      while (startM < 0) { startM += 12; startY -= 1; }
    }
    const out: { year: number; month0: number; label: string; key: string }[] = [];
    let y = endY;
    let m = endM;
    // walk backward from the newest completed month to the earliest, latest first (cap at 120 months)
    for (let i = 0; i < 120; i++) {
      out.push({ year: y, month0: m, label: `${MONTH_NAMES[m]} ${y}`, key: `${y}-${m}` });
      if (y === startY && m === startM) break;
      m -= 1;
      if (m < 0) { m = 11; y -= 1; }
    }
    return out;
  }, [range]);

  async function exportMonth(mo: { year: number; month0: number; label: string; key: string }) {
    setReportBusy(mo.key);
    setReportError(null);
    try {
      const { filename, base64, count } = await getMonthlyShipmentsXlsx(mo.year, mo.month0);
      if (count === 0) { setReportError(`No shipments in ${mo.label}.`); return; }
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setShowReport(false);
    } catch (e) {
      setReportError(e instanceof Error ? e.message : 'Report failed.');
    } finally {
      setReportBusy(null);
    }
  }

  return (
    <div className="ops">
      <AppHeader active="outbound" userEmail={userEmail} />
      <Breadcrumbs items={[{ label: 'Home', href: '/' }, { label: 'Outbound', href: '/outbound' }, { label: TAB_LABELS[tab] }]} />

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
        <button className="orders-new" onClick={() => setShowReport(true)}>Monthly report</button>
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

      {/* Monthly report — pick a completed month, download an .xlsx of that month's shipments. */}
      {showReport && (
        <div className="orders-overlay" role="dialog" aria-modal="true" aria-label="Monthly report">
          <div className="orders-overlay-bar">
            <span className="orders-overlay-title">Monthly shipment report</span>
            <button className="orders-overlay-close" onClick={() => setShowReport(false)} aria-label="Close">×</button>
          </div>
          <div className="orders-overlay-body report-body">
            <p className="hint">Pick a month to download an Excel report of that month&apos;s shipments.</p>
            {reportError && <div className="validation err">{reportError}</div>}
            <ul className="month-list">
              {months.map((mo) => (
                <li key={mo.key}>
                  <button className="month-btn" onClick={() => exportMonth(mo)} disabled={!!reportBusy}>
                    <span>{mo.label}</span>
                    <span className="month-btn-cta">{reportBusy === mo.key ? 'generating…' : 'download .xlsx'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
