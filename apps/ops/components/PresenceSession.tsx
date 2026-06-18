'use client';

// Presence mode (docs/016 §2A) — the phone "walk & confirm" pass. By-brand checklist; each row is
// SKU + name + image + expected qty + a ✓ "it's here". Ticking collapses the row into "done".
// Add-missing pulls in a SKU that's present but not listed. Close opens the SHARED confirm window
// (CloseConfirm): un-ticked SKUs are NEVER auto-zeroed — each is set-to-0 or leave there.

import { useEffect, useMemo, useRef, useState } from 'react';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import CloseConfirm from '@/components/CloseConfirm';
import {
  addMissingSku,
  cancelStockCheck,
  closeStockCheck,
  confirmPresent,
  getSessionLines,
  searchSkus,
  unconfirmPresent,
} from '@/app/stock-check/actions';
import type { CloseConfirmData, CloseReviewEntry, LineRow, SessionRow, SkuHit } from '@/app/stock-check/types';

export default function PresenceSession({
  session,
  onExit,
  onClosed,
}: {
  session: SessionRow;
  onExit: () => void;
  onClosed: () => void;
}) {
  const [lines, setLines] = useState<LineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);

  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SkuHit[]>([]);
  const [searching, setSearching] = useState(false);

  const [confirm, setConfirm] = useState<CloseConfirmData | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeErr, setCloseErr] = useState<string | null>(null);

  const searchReq = useRef(0);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reload(): Promise<LineRow[]> {
    setLoading(true);
    setError(null);
    try {
      const l = await getSessionLines(session.stock_check_id);
      setLines(l);
      return l;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the checklist.');
      return lines;
    } finally {
      setLoading(false);
    }
  }

  async function doCancel() {
    if (!window.confirm('Cancel this count? Nothing will be saved and the scope is freed.')) return;
    setError(null);
    try {
      await cancelStockCheck(session.stock_check_id);
      onExit();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cancel failed.');
    }
  }

  const imgCodes = useMemo(() => lines.map((l) => l.item_code), [lines]);
  const imgMap = useSkuImages(imgCodes);

  async function tick(line: LineRow, on: boolean) {
    setError(null);
    setLines((ls) => ls.map((l) => (l.line_id === line.line_id ? { ...l, confirmed: on } : l)));
    try {
      if (on) await confirmPresent(line.line_id);
      else await unconfirmPresent(line.line_id);
    } catch (e) {
      setLines((ls) => ls.map((l) => (l.line_id === line.line_id ? { ...l, confirmed: !on } : l)));
      setError(e instanceof Error ? e.message : 'Update failed.');
    }
  }

  async function doSearch() {
    const myReq = ++searchReq.current;
    setSearching(true);
    try {
      const r = await searchSkus(q);
      if (searchReq.current === myReq) setHits(r);
    } catch {
      /* search failures are non-fatal */
    } finally {
      if (searchReq.current === myReq) setSearching(false);
    }
  }

  async function add(code: string, qty: number) {
    setError(null);
    try {
      await addMissingSku(session.stock_check_id, code, qty);
      setQ('');
      setHits([]);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Add failed.');
    }
  }

  async function openClose() {
    const fresh = await reload(); // authoritative: the review must cover every server-side un-ticked line
    const decisions = fresh
      .filter((l) => !l.confirmed && !l.added_missing)
      .map((l) => ({ item_code: l.item_code, name: l.name, expected: l.physical }));
    const added = fresh
      .filter((l) => l.added_missing)
      .map((l) => ({ item_code: l.item_code, name: l.name, qty: l.counted_qty ?? 0 }));
    setConfirm({ mode: 'presence', countDeltas: [], decisions, added });
    setCloseErr(null);
  }

  async function doClose(review: CloseReviewEntry[]) {
    setClosing(true);
    setCloseErr(null);
    try {
      await closeStockCheck(session.stock_check_id, review);
      onClosed();
    } catch (e) {
      setCloseErr(e instanceof Error ? e.message : 'Close failed.');
      setClosing(false);
    }
  }

  const toCheck = lines.filter((l) => !l.confirmed && !l.added_missing);
  const done = lines.filter((l) => l.confirmed || l.added_missing);
  const checked = lines.filter((l) => l.confirmed).length;
  const listed = useMemo(() => new Set(lines.map((l) => l.item_code)), [lines]);

  const groups = useMemo(() => {
    const m = new Map<string, LineRow[]>();
    for (const l of toCheck) {
      const k = l.brand_prefix ?? '—';
      const arr = m.get(k) ?? (m.set(k, []), m.get(k)!);
      arr.push(l);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [toCheck]);

  return (
    <div className="sc-wrap">
      <div className="sc-sess-head">
        <button className="btn-link" onClick={onExit}>← sessions</button>
        <div className="sc-sess-head-main">
          <div className="sc-sess-title">Presence · {session.counted_by}</div>
          <div className="sc-sess-sub">
            {session.scope === 'all_active' ? 'all active' : (session.scope_brands ?? []).join(', ')}
          </div>
        </div>
        <div className="sc-prog">{checked}/{lines.length} ✓</div>
        <button className="btn-link sc-danger" onClick={() => void doCancel()}>cancel</button>
        <button className="btn-primary" onClick={() => void openClose()} disabled={loading}>Close…</button>
      </div>

      {error && <div className="validation err" style={{ marginTop: 12 }}>{error}</div>}

      <div className="sc-add">
        <input
          type="text"
          placeholder="add a SKU that's here but not listed — search code/name/barcode"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void doSearch(); } }}
        />
        <button className="btn-secondary" onClick={() => void doSearch()} disabled={searching}>{searching ? '…' : 'search'}</button>
      </div>
      {hits.length > 0 && (
        <div className="sc-hits">
          {hits.filter((h) => !listed.has(h.item_code)).map((h) => (
            <AddHit key={h.item_code} hit={h} imgMap={imgMap} onAdd={(qty) => void add(h.item_code, qty)} />
          ))}
          {hits.every((h) => listed.has(h.item_code)) && <div className="sc-empty">All matches are already on the checklist.</div>}
        </div>
      )}

      {loading ? (
        <div className="sc-empty">Loading the checklist…</div>
      ) : (
        <>
          {toCheck.length === 0 && <div className="validation ok" style={{ marginTop: 12 }}>All checked — close when ready.</div>}
          {groups.map(([brand, rows]) => (
            <div key={brand} className="sc-grp">
              <div className="sc-grp-head">{brand} <span className="sc-exp">({rows.length})</span></div>
              {rows.map((l) => (
                <label key={l.line_id} className="sc-check-row">
                  <input type="checkbox" checked={l.confirmed} onChange={(e) => void tick(l, e.target.checked)} />
                  <SkuImage status={imgMap[l.item_code]?.status} displayUrl={imgMap[l.item_code]?.displayUrl} name={l.name} size={40} />
                  <span className="ff-code">{l.item_code}</span>
                  <span className="ff-name">{l.name}</span>
                  <span className="sc-exp">exp {l.physical}</span>
                </label>
              ))}
            </div>
          ))}

          {done.length > 0 && (
            <div className="sc-grp">
              <button className="sc-grp-head sc-grp-toggle" onClick={() => setShowDone((v) => !v)}>
                {showDone ? '▾' : '▸'} Done <span className="sc-exp">({done.length})</span>
              </button>
              {showDone &&
                done.map((l) => (
                  <label key={l.line_id} className="sc-check-row done">
                    <input
                      type="checkbox"
                      checked={l.confirmed}
                      disabled={l.added_missing}
                      onChange={(e) => void tick(l, e.target.checked)}
                    />
                    <SkuImage status={imgMap[l.item_code]?.status} displayUrl={imgMap[l.item_code]?.displayUrl} name={l.name} size={40} />
                    <span className="ff-code">{l.item_code}</span>
                    <span className="ff-name">{l.name}</span>
                    {l.added_missing ? <span className="badge ready">+{l.counted_qty ?? 0} added</span> : <span className="sc-exp">exp {l.physical}</span>}
                  </label>
                ))}
            </div>
          )}
        </>
      )}

      {confirm && (
        <CloseConfirm
          data={confirm}
          busy={closing}
          error={closeErr}
          onConfirm={(review) => void doClose(review)}
          onCancel={() => { if (!closing) setConfirm(null); }}
        />
      )}
    </div>
  );
}

// one add-missing search result with its own qty input
function AddHit({
  hit,
  imgMap,
  onAdd,
}: {
  hit: SkuHit;
  imgMap: ReturnType<typeof useSkuImages>;
  onAdd: (qty: number) => void;
}) {
  const [qty, setQty] = useState(1);
  return (
    <div className="sc-hit">
      <SkuImage status={imgMap[hit.item_code]?.status} displayUrl={imgMap[hit.item_code]?.displayUrl} name={hit.name} size={32} />
      <span className="ff-code">{hit.item_code}</span>
      <span className="ff-name">{hit.name}</span>
      <span className="sc-exp">avail {hit.available}</span>
      <input
        type="number"
        className="sc-qty"
        min={1}
        value={qty}
        onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
      />
      <button className="btn-secondary" onClick={() => onAdd(qty)}>add</button>
    </div>
  );
}
