'use client';

// Pre-submit receive-confirmation window (PR17 §6). REUSES the shared .sc-modal* chrome that Stock
// Check's CloseConfirm shipped (darkened backdrop, centered, screenshot-friendly, back/confirm) but
// with receiving-correct rows: per SKU expected (open PO qty) vs counted, classified ok / short /
// over / unexpected, plus the excluded subset. The shorts revert to the open Order list ONLY on
// close — the operator chooses leave-open vs close-shipment here. Back resumes scanning; Confirm
// calls record_receipt. (CloseConfirm itself is hard-wired to set-0/leave count decisions that don't
// map to receiving, so this is a sibling, not a reuse of that component — same window, right rows.)

import { useState } from 'react';
import type { ReceiveClass, ReceiveConfirmData } from '@/app/inbound/types';

const CLASS_LABEL: Record<ReceiveClass, string> = {
  ok: '✓ match',
  short: '⚠ short',
  over: '✓ over',
  unexpected: '⚠ unexpected',
};

export default function ReceiveConfirm({
  data,
  canClose,
  defaultClose,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  data: ReceiveConfirmData;
  canClose: boolean; // a real shipment can be closed (ad-hoc cannot)
  defaultClose: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: (closeShipment: boolean) => void;
  onCancel: () => void;
}) {
  const [close, setClose] = useState(canClose ? defaultClose : false);

  const sellable = data.rows.reduce((s, r) => s + (r.counted - r.excluded_qty), 0);
  const willRevert = close && data.shorts.length > 0;

  return (
    <div className="sc-modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="sc-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="sc-modal-head">
          <div className="sc-modal-title">Confirm receive — {data.ship_id}</div>
          <div className="sc-modal-sub">
            {sellable} sellable unit{sellable === 1 ? '' : 's'} across {data.rows.length} SKU{data.rows.length === 1 ? '' : 's'}
            {willRevert ? ` · ${data.shorts.length} short line${data.shorts.length === 1 ? '' : 's'} will revert to Order` : ''}
          </div>
        </div>

        <div className="sc-modal-body">
          {data.rows.length === 0 && <div className="sc-empty">Nothing counted yet — scan or add a line first.</div>}
          {data.rows.length > 0 && (
            <div className="sc-sec">
              <div className="sc-sec-title">Expected vs counted ({data.rows.length})</div>
              {data.rows.map((r) => (
                <div key={r.item_code} className="sc-row">
                  <span className="ff-code">{r.item_code}</span>
                  <span className="ff-name">{r.name}</span>
                  <span className="sc-exp">
                    counted {r.counted}
                    {r.excluded_qty > 0 ? ` (${r.excluded_qty} excl)` : ''} · exp {r.expected}
                  </span>
                  <span className={`rcv-badge ${r.cls}`}>{CLASS_LABEL[r.cls]}</span>
                </div>
              ))}
            </div>
          )}

          {canClose && (
            <div className="sc-sec">
              <div className="sc-sec-title">Shipment</div>
              <div className="sc-row">
                <span className="sc-choice">
                  <button className={close ? '' : 'active'} onClick={() => setClose(false)}>
                    Leave open
                  </button>
                  <button className={close ? 'active danger' : ''} onClick={() => setClose(true)}>
                    Close shipment
                  </button>
                </span>
                <span className="ff-name">
                  {close
                    ? 'Done — short / un-counted lines revert to the open Order list.'
                    : 'More coming — short / un-counted lines stay on this shipment.'}
                </span>
              </div>
            </div>
          )}

          {error && <div className="validation err" style={{ marginTop: 10 }}>{error}</div>}
        </div>

        <div className="sc-modal-foot">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>← Back to scanning</button>
          <button className="btn-primary" onClick={() => onConfirm(close)} disabled={busy || data.rows.length === 0}>
            {busy ? 'Saving…' : close ? 'Confirm & close' : 'Confirm receive'}
          </button>
        </div>
      </div>
    </div>
  );
}
