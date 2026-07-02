'use client';

// Pre-submit receive-confirmation window (PR17 §6). Renders the shared ConfirmModal shell (PR28 §5 —
// the .sc-modal* chrome, extracted so it's defined once) with receiving-correct rows: per SKU
// expected (open PO qty) vs counted, classified ok / short / over / unexpected, plus the excluded
// subset. The shorts revert to the open Order list ONLY on close — the operator chooses leave-open
// vs close-shipment here. Back resumes scanning; Confirm calls record_receipt. This component owns
// the receive rows + close toggle; CloseConfirm owns the count set-0/leave rows — two row-bodies,
// one shell (Andrio's redline: extraction, not a literal merge into CloseConfirm).

import { useState } from 'react';
import ConfirmModal from '@/components/ConfirmModal';
import type { ReceiveClass, ReceiveConfirmData } from '@/app/inbound/types';
import type { StaffMember } from '@/app/settings/types';

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
  staffOptions,
  defaultStaff,
  defaultDate,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  data: ReceiveConfirmData;
  canClose: boolean; // a real shipment can be closed (ad-hoc cannot)
  defaultClose: boolean;
  staffOptions: StaffMember[];
  defaultStaff: string | null; // last-used staff (persisted per device)
  defaultDate: string;         // 'YYYY-MM-DD' — the draft's receive date, editable here
  busy?: boolean;
  error?: string | null;
  onConfirm: (opts: { closeShipment: boolean; staff: string | null; receiveDate: string }) => void;
  onCancel: () => void;
}) {
  const [close, setClose] = useState(canClose ? defaultClose : false);
  const [staff, setStaff] = useState<string>(defaultStaff ?? '');
  const [receiveDate, setReceiveDate] = useState(defaultDate);

  const sellable = data.rows.reduce((s, r) => s + (r.counted - r.excluded_qty), 0);
  const willRevert = close && data.shorts.length > 0;

  const subtitle =
    `${sellable} sellable unit${sellable === 1 ? '' : 's'} across ${data.rows.length} SKU${data.rows.length === 1 ? '' : 's'}` +
    (willRevert ? ` · ${data.shorts.length} short line${data.shorts.length === 1 ? '' : 's'} will revert to Order` : '');

  return (
    <ConfirmModal
      title={`Confirm receive — ${data.ship_id}`}
      subtitle={subtitle}
      error={error}
      busy={busy}
      confirmLabel={busy ? 'Saving…' : close ? 'Confirm & close' : 'Confirm receive'}
      confirmDisabled={data.rows.length === 0}
      cancelLabel="← Back to scanning"
      onConfirm={() => onConfirm({ closeShipment: close, staff: staff.trim() || null, receiveDate })}
      onCancel={onCancel}
    >
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

          {/* Who received + when — captured here as part of Mark received. */}
          <div className="sc-sec">
            <div className="sc-sec-title">Receiving</div>
            <div className="sc-row rcv-confirm-meta">
              <label className="rcv-date-field">
                <span className="fd-label">Staff</span>
                <select className="staff-bar-select" value={staff} onChange={(e) => setStaff(e.target.value)} disabled={busy}>
                  <option value="">— none —</option>
                  {staffOptions.map((s) => (
                    <option key={s.id} value={s.label}>{s.icon ? `${s.icon} ` : ''}{s.label}</option>
                  ))}
                </select>
              </label>
              <label className="rcv-date-field">
                <span className="fd-label">Receive date</span>
                <input type="date" className="rcv-date-input" value={receiveDate} onChange={(e) => setReceiveDate(e.target.value)} disabled={busy} />
              </label>
            </div>
          </div>

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
    </ConfirmModal>
  );
}
