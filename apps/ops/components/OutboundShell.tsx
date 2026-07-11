'use client';

// Outbound window: two tabs — Ready to ship (the live queue, with a count badge) and History (orders
// we've shipped). Mirrors the Sales window shell: both boards stay mounted, inactive one hidden, so
// switching tabs keeps selection + scroll. The boards own their own search.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUrlTab } from '@/components/useUrlTab';
import { useEscToClose } from '@/components/useOverlayClose';
import AppHeader from '@/components/AppHeader';
import Breadcrumbs from '@/components/Breadcrumbs';
import OutboundBoard from '@/components/OutboundBoard';
import OutboundHistoryBoard from '@/components/OutboundHistoryBoard';
import { getMonthlyShipmentsXlsx, getShipmentMonthRange } from '@/app/outbound/actions';
import type { ShipQueueRow } from '@jigzle/db/types';
import type { BoxPreset, StaffMember } from '@/app/settings/types';

// PR320 — report (document) icon for the Monthly report button.
const ReportIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="16" y2="17" />
  </svg>
);

type OutboundTab = 'ready' | 'history';
const TAB_LABELS: Record<OutboundTab, string> = { ready: 'Dispatch', history: 'History' };
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function OutboundShell({
  userEmail,
  initialQueue,
  boxPresets,
  staffOptions,
  initialOrderId,
}: {
  userEmail: string;
  initialQueue: ShipQueueRow[];
  boxPresets: BoxPreset[];
  staffOptions: StaffMember[];
  initialOrderId: string | null;
}) {
  // PR223 — the active tab is mirrored to ?tab= so the breadcrumb Refresh (a hard reload) stays put.
  const [tab, setTab] = useUrlTab<OutboundTab>('tab', 'ready', ['ready', 'history']);
  const [readyCount, setReadyCount] = useState(initialQueue.length);
  const onReadyCount = useCallback((n: number) => setReadyCount(n), []);
  // PR195: bumped when History cancels a shipment → OutboundBoard reloads its queue (the un-recorded
  // order's lines return to Ready-to-ship). Both boards stay mounted, so this keeps them in sync.
  const [readyReload, setReadyReload] = useState(0);
  const onShipmentCancelled = useCallback(() => setReadyReload((n) => n + 1), []);
  // PR155: a board's bodyview DETAIL is open → hide the tab bar (breadcrumb stays). Tracked per tab
  // because both boards stay mounted; the bar hides only when the ACTIVE tab's detail is open.
  const [detailOpenBy, setDetailOpenBy] = useState<Record<OutboundTab, boolean>>({ ready: false, history: false });
  const onReadyDetail = useCallback((open: boolean) => setDetailOpenBy((p) => (p.ready === open ? p : { ...p, ready: open })), []);
  const onHistoryDetail = useCallback((open: boolean) => setDetailOpenBy((p) => (p.history === open ? p : { ...p, history: open })), []);
  const detailOpen = detailOpenBy[tab];

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

  // PR320 — Esc closes the Monthly report modal (matches every other overlay).
  useEscToClose(showReport, () => setShowReport(false));

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

      {!detailOpen && (
      <div className="orders-bar">
        <nav className="orders-tabs" role="tablist" aria-label="Outbound">
          <button
            role="tab"
            aria-selected={tab === 'ready'}
            className={`orders-tab ${tab === 'ready' ? 'active' : ''}`}
            onClick={() => setTab('ready')}
          >
            Dispatch<span className="orders-tab-count">{readyCount}</span>
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
        <button className="orders-new btn-ico" onClick={() => setShowReport(true)}><ReportIcon />Monthly report</button>
      </div>
      )}

      {/* PR155: the staff picker moved INTO the Ready-to-ship tab body (History carries no staff). */}
      <div className="orders-panels">
        <div hidden={tab !== 'ready'}>
          <OutboundBoard
            embedded
            initialQueue={initialQueue}
            boxPresets={boxPresets}
            initialOrderId={initialOrderId}
            userEmail={userEmail}
            staffOptions={staffOptions}
            onCountChange={onReadyCount}
            onDetailOpenChange={onReadyDetail}
            reloadKey={readyReload}
          />
        </div>
        <div hidden={tab !== 'history'}>
          <OutboundHistoryBoard active={tab === 'history'} boxPresets={boxPresets} onDetailOpenChange={onHistoryDetail} onCancelled={onShipmentCancelled} />
        </div>
      </div>

      {/* Monthly report — a standard centered modal (PR320): pick a completed month, download its .xlsx. */}
      {showReport && (
        <div className="sc-modal-backdrop" onClick={() => setShowReport(false)}>
          <div className="sc-modal" role="dialog" aria-modal="true" aria-label="Monthly report" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <div className="sc-modal-title">Monthly shipment report</div>
              <button className="sc-modal-x" onClick={() => setShowReport(false)} aria-label="Close">×</button>
            </div>
            <div className="sc-modal-body">
              <p className="hint" style={{ marginBottom: 10 }}>Pick a month to download an Excel report of that month&apos;s shipments.</p>
              {reportError && <div className="validation err" style={{ marginBottom: 10 }}>{reportError}</div>}
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
        </div>
      )}
    </div>
  );
}
