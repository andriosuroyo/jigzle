'use client';

// Shared pre-submit close-confirmation window (docs/016 §2B/§7 v0.4). The SAME window for Count-close
// and Presence-close (and the future Receiving-close). It lists every change that WILL be written
// (count deltas, added-missing) plus every in-scope SKU that needs a per-row decision — un-scanned
// (Count) / un-ticked (Presence) — each set-to-0 or leave. Default is LEAVE (un-scanned/un-ticked is
// never auto-zeroed); only an explicit "set 0" writes −expected. Back resumes counting; Confirm
// writes the adjustments (still per-row editable/deletable afterward). Darkened backdrop, centered.

import { useMemo, useState } from 'react';
import type { CloseConfirmData, CloseReviewEntry } from '@/app/stock-check/types';

function fmt(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

export default function CloseConfirm({
  data,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  data: CloseConfirmData;
  busy?: boolean;
  error?: string | null;
  onConfirm: (review: CloseReviewEntry[]) => void;
  onCancel: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, 'zeroed' | 'ignored'>>(() =>
    Object.fromEntries(data.decisions.map((d) => [d.item_code, 'ignored' as const]))
  );

  const net = useMemo(() => {
    let n = 0;
    for (const d of data.countDeltas) n += d.delta;
    for (const a of data.added) n += a.qty;
    for (const d of data.decisions) if (choices[d.item_code] === 'zeroed') n -= d.expected;
    return n;
  }, [data, choices]);

  const zeroed = data.decisions.filter((d) => choices[d.item_code] === 'zeroed' && d.expected !== 0).length;
  const writeCount = data.countDeltas.length + data.added.length + zeroed;
  const decisionLabel = data.mode === 'count' ? 'Not scanned' : 'Not ticked';

  function confirm() {
    onConfirm(data.decisions.map((d) => ({ item_code: d.item_code, action: choices[d.item_code] })));
  }

  return (
    <div className="sc-modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="sc-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="sc-modal-head">
          <div className="sc-modal-title">Confirm close — {data.mode === 'count' ? 'Count' : 'Presence'}</div>
          <div className="sc-modal-sub">
            {writeCount === 0
              ? 'No adjustments will be written.'
              : `${writeCount} adjustment${writeCount === 1 ? '' : 's'} · net ${fmt(net)}`}
          </div>
        </div>

        <div className="sc-modal-body">
          {data.countDeltas.length > 0 && (
            <div className="sc-sec">
              <div className="sc-sec-title">Counted — differs from system ({data.countDeltas.length})</div>
              {data.countDeltas.map((d) => (
                <div key={d.item_code} className="sc-row">
                  <span className="ff-code">{d.item_code}</span>
                  <span className="ff-name">{d.name}</span>
                  <span className="sc-exp">counted {d.counted} · was {d.expected}</span>
                  <span className={`sc-delta ${d.delta >= 0 ? 'pos' : 'neg'}`}>{fmt(d.delta)}</span>
                </div>
              ))}
            </div>
          )}

          {data.added.length > 0 && (
            <div className="sc-sec">
              <div className="sc-sec-title">Added — not on the list ({data.added.length})</div>
              {data.added.map((a) => (
                <div key={a.item_code} className="sc-row">
                  <span className="ff-code">{a.item_code}</span>
                  <span className="ff-name">{a.name}</span>
                  <span className="sc-delta pos">{fmt(a.qty)}</span>
                </div>
              ))}
            </div>
          )}

          {data.decisions.length > 0 && (
            <div className="sc-sec">
              <div className="sc-sec-title">{decisionLabel} — set to 0 or leave ({data.decisions.length})</div>
              {data.decisions.map((d) => {
                const choice = choices[d.item_code];
                return (
                  <div key={d.item_code} className="sc-row">
                    <span className="ff-code">{d.item_code}</span>
                    <span className="ff-name">{d.name}</span>
                    <span className="sc-exp">system {d.expected}</span>
                    <span className="sc-choice">
                      <button
                        className={choice === 'zeroed' ? 'active danger' : ''}
                        onClick={() => setChoices((c) => ({ ...c, [d.item_code]: 'zeroed' }))}
                      >
                        set 0 ({fmt(-d.expected)})
                      </button>
                      <button
                        className={choice === 'ignored' ? 'active' : ''}
                        onClick={() => setChoices((c) => ({ ...c, [d.item_code]: 'ignored' }))}
                      >
                        leave
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {writeCount === 0 && data.decisions.length === 0 && (
            <div className="sc-empty">Everything matches the system — nothing to write.</div>
          )}

          {error && <div className="validation err" style={{ marginTop: 10 }}>{error}</div>}
        </div>

        <div className="sc-modal-foot">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>← Back to counting</button>
          <button className="btn-primary" onClick={confirm} disabled={busy}>{busy ? 'Writing…' : 'Confirm & close'}</button>
        </div>
      </div>
    </div>
  );
}
