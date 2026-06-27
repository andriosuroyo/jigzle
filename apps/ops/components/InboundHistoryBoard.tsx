'use client';

// Inbound → History tab: confirmed receipts grouped per ship_id, read from the inbound ledger via
// getReceiveHistory. Read-only, searchable by ship id / SKU / name. Each row carries its own detail, so
// the detail pane renders straight from the selected row. Mirrors OutboundHistoryBoard's shape.

import { useEffect, useMemo, useRef, useState } from 'react';
import { getReceiveHistory } from '@/app/inbound/actions';
import type { InboundHistoryRow } from '@/app/inbound/types';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { SKU_IMG } from '@/components/skuImageSizes';

const fmtDate = (s: string | null): string => (s ? s.slice(0, 10) : '—');

export default function InboundHistoryBoard({
  initialRows,
  onCountChange,
  reloadKey = 0,
}: {
  initialRows: InboundHistoryRow[];
  onCountChange?: (n: number) => void;
  reloadKey?: number;
}) {
  const [rows, setRows] = useState<InboundHistoryRow[]>(initialRows);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [selKey, setSelKey] = useState<string | null>(null);
  const reqRef = useRef(0);

  const sel = useMemo(() => rows.find((r) => r.ship_id === selKey) ?? null, [rows, selKey]);

  const imgCodes = useMemo(
    () => (sel?.items ?? []).map((i) => i.item_code).filter((c): c is string => !!c),
    [sel]
  );
  const imgMap = useSkuImages(imgCodes);

  async function runSearch() {
    setSearching(true);
    const myReq = ++reqRef.current;
    try {
      const r = await getReceiveHistory(query.trim());
      if (reqRef.current === myReq) setRows(r);
    } catch {
      /* keep current on transient error */
    } finally {
      if (reqRef.current === myReq) setSearching(false);
    }
  }

  useEffect(() => { onCountChange?.(rows.length); }, [rows, onCountChange]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (reloadKey) runSearch(); }, [reloadKey]);

  return (
    <div className="fulfill-layout">
      {/* ── List ── */}
      <aside className="fq-pane">
        <div className="search-row" style={{ padding: '8px' }}>
          <input
            type="text"
            inputMode="search"
            placeholder="Search ship id, SKU, or name…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }}
          />
          <button className="btn-secondary" onClick={runSearch} disabled={searching}>{searching ? '…' : 'Search'}</button>
        </div>
        {rows.length === 0 && <div className="hint fq-empty">{searching ? 'Searching…' : 'No received shipments.'}</div>}
        <ul className="fq-list">
          {rows.map((r) => (
            <li key={r.ship_id}>
              <button className={`fq-row ${selKey === r.ship_id ? 'active' : ''}`} onClick={() => setSelKey(r.ship_id)}>
                <div className="fq-row-top">
                  <span className="fq-id">{r.ship_id}</span>
                  <span className="fq-id-sub">{fmtDate(r.receive_date)}</span>
                </div>
                <div className="fq-row-bot">
                  <span className="ff-items-skus">
                    {r.item_count} {r.item_count === 1 ? 'item' : 'items'}{r.sku_codes.length ? ` (${r.sku_codes.join(', ')})` : ''}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* ── Detail (read-only) ── */}
      <main className="fd-pane">
        {!sel && <div className="fd-empty">Pick a shipment to see what was received.</div>}
        {sel && (
          <>
            <div className="fd-head">
              <div className="fd-title">{sel.ship_id}</div>
              <div className="fd-sub">
                {sel.tracking ? sel.tracking : sel.is_adhoc ? 'ad-hoc receive' : 'no tracking'}
                {sel.receive_date ? ` · received ${fmtDate(sel.receive_date)}` : ''}
              </div>
            </div>

            <section className="fd-section">
              <div className="fd-section-head">Received items</div>
              <ul className="ff-lines">
                {sel.items.map((l, i) => (
                  <li key={i} className="ff-line pend-line">
                    <SkuImage status={imgMap[l.item_code ?? '']?.status} displayUrl={imgMap[l.item_code ?? '']?.displayUrl} name={l.name} size={SKU_IMG.sm} />
                    <div className="pend-line-main">
                      <span className="ff-code">{l.item_code || '—'}</span>
                      <span className="ff-name">{l.name}</span>
                    </div>
                    <span className="ff-qty">
                      ×{l.qty}
                      {l.excluded_qty > 0 && <span className="hint" style={{ marginLeft: 6 }}>+{l.excluded_qty} excl</span>}
                    </span>
                  </li>
                ))}
                {sel.items.length === 0 && <li className="hint">No received items.</li>}
              </ul>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
