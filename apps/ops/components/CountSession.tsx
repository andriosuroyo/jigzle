'use client';

// Count mode (docs/016 §2B) — the desktop barcode pass. Scan → resolve via the composite
// (barcode, item_code) model: one owner → counted_qty += 1; a shared barcode (>1 owner) → the SHARED
// BarcodePicker. A live "not yet scanned" panel lists in-scope SKUs still at counted 0; manual
// set / +/− corrects without re-scanning. Close opens the SHARED CloseConfirm: every scanned delta
// is shown and auto-written; un-scanned SKUs default to LEAVE (set-0 per row to zero them).

import { useEffect, useMemo, useRef, useState } from 'react';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import BarcodePicker from '@/components/BarcodePicker';
import CloseConfirm from '@/components/CloseConfirm';
import {
  addMissingSku,
  cancelStockCheck,
  closeStockCheck,
  getSessionLines,
  recordCount,
  resolveScan,
  searchSkus,
} from '@/app/stock-check/actions';
import type {
  CloseConfirmData,
  CloseReviewEntry,
  LineRow,
  ScanSku,
  SessionRow,
  SkuHit,
} from '@/app/stock-check/types';

export default function CountSession({
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

  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const [picker, setPicker] = useState<ScanSku[] | null>(null);

  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SkuHit[]>([]);
  const [searching, setSearching] = useState(false);

  const [confirm, setConfirm] = useState<CloseConfirmData | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeErr, setCloseErr] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const searchReq = useRef(0);

  useEffect(() => {
    void reload();
    inputRef.current?.focus();
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
      setError(e instanceof Error ? e.message : 'Failed to load the session.');
      return lines;
    } finally {
      setLoading(false);
    }
  }

  const imgCodes = useMemo(() => {
    const set = new Set(lines.map((l) => l.item_code));
    picker?.forEach((p) => set.add(p.item_code));
    hits.forEach((h) => set.add(h.item_code));
    return [...set];
  }, [lines, picker, hits]);
  const imgMap = useSkuImages(imgCodes);

  // increment a SKU by 1 (scan). Updates locally when the line exists; reloads when a brand-new
  // (out-of-scope) line was just created.
  async function bump(itemCode: string) {
    setError(null);
    const exists = lines.some((l) => l.item_code === itemCode);
    try {
      const newQty = await recordCount(session.stock_check_id, itemCode, 'inc', 1);
      if (exists) {
        setLines((ls) => ls.map((l) => (l.item_code === itemCode ? { ...l, counted_qty: newQty, confirmed: true } : l)));
      } else {
        await reload();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Count failed.');
    }
  }

  async function setQty(itemCode: string, qty: number) {
    setError(null);
    const v = Math.max(0, Math.floor(qty));
    try {
      await recordCount(session.stock_check_id, itemCode, 'set', v);
      setLines((ls) => ls.map((l) => (l.item_code === itemCode ? { ...l, counted_qty: v, confirmed: true } : l)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed.');
    }
  }

  async function doScan() {
    const code = scan.trim();
    if (!code) return;
    setScan('');
    setPicker(null);
    setScanMsg('resolving…');
    try {
      const res = await resolveScan(code);
      if (res.status === 'resolved') {
        await bump(res.sku.item_code);
        setScanMsg(`✓ ${res.sku.item_code} +1`);
      } else if (res.status === 'collision') {
        setPicker(res.skus);
        setScanMsg(`⚠ barcode ${code} → ${res.skus.length} SKUs — pick one`);
      } else {
        setScanMsg(`unknown barcode ${code} — use search below to add it`);
      }
    } catch (e) {
      setScanMsg(e instanceof Error ? e.message : 'scan failed');
    }
    inputRef.current?.focus();
  }

  function pick(sku: ScanSku) {
    void bump(sku.item_code);
    setScanMsg(`✓ ${sku.item_code} +1`);
    setPicker(null);
    inputRef.current?.focus();
  }

  async function doSearch() {
    const myReq = ++searchReq.current;
    setSearching(true);
    try {
      const r = await searchSkus(q);
      if (searchReq.current === myReq) setHits(r);
    } catch {
      /* non-fatal */
    } finally {
      if (searchReq.current === myReq) setSearching(false);
    }
  }

  async function addManual(code: string, qty: number) {
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
    const fresh = await reload();
    // In Count, an added-missing SKU's written delta is (counted − expected) — same as any counted
    // line — so it belongs in countDeltas with its true expected/delta, NOT the flat "+qty" added
    // bucket (which only matches Presence's +counted_qty close math). "was 0" already flags new SKUs.
    const countDeltas = fresh
      .filter((l) => l.counted_qty != null && l.counted_qty - l.physical !== 0)
      .map((l) => ({ item_code: l.item_code, name: l.name, expected: l.physical, counted: l.counted_qty as number, delta: (l.counted_qty as number) - l.physical }));
    const decisions = fresh
      .filter((l) => l.counted_qty == null)
      .map((l) => ({ item_code: l.item_code, name: l.name, expected: l.physical }));
    setConfirm({ mode: 'count', countDeltas, decisions, added: [] });
    setCloseErr(null);
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

  const counted = lines.filter((l) => l.counted_qty != null);
  const notScanned = lines.filter((l) => l.counted_qty == null);
  const listed = useMemo(() => new Set(lines.map((l) => l.item_code)), [lines]);

  return (
    <div className="sc-wrap">
      <div className="sc-sess-head">
        <button className="btn-link" onClick={onExit}>← sessions</button>
        <div className="sc-sess-head-main">
          <div className="sc-sess-title">Count · {session.counted_by}</div>
          <div className="sc-sess-sub">
            {session.scope === 'all_active' ? 'all active' : (session.scope_brands ?? []).join(', ')}
          </div>
        </div>
        <div className="sc-prog">{counted.length}/{lines.length} scanned</div>
        <button className="btn-link sc-danger" onClick={() => void doCancel()}>cancel</button>
        <button className="btn-primary" onClick={() => void openClose()} disabled={loading}>Close…</button>
      </div>

      {error && <div className="validation err" style={{ marginTop: 12 }}>{error}</div>}

      <div className="sc-scan">
        <input
          ref={inputRef}
          type="text"
          className="rcv-shipid"
          placeholder="scan a barcode"
          value={scan}
          onChange={(e) => setScan(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void doScan(); } }}
        />
        {scanMsg && <div className="sc-scanmsg">{scanMsg}</div>}
        {picker && <BarcodePicker skus={picker} imgMap={imgMap} onPick={pick} onCancel={() => setPicker(null)} />}
      </div>

      <div className="sc-add">
        <input
          type="text"
          placeholder="no barcode? search code/name to add a SKU"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void doSearch(); } }}
        />
        <button className="btn-secondary" onClick={() => void doSearch()} disabled={searching}>{searching ? '…' : 'search'}</button>
      </div>
      {hits.length > 0 && (
        <div className="sc-hits">
          {hits.filter((h) => !listed.has(h.item_code)).map((h) => (
            <CountAddHit key={h.item_code} hit={h} imgMap={imgMap} onAdd={(qty) => void addManual(h.item_code, qty)} />
          ))}
          {hits.every((h) => listed.has(h.item_code)) && <div className="sc-empty">All matches are already in this count — scan or set them above.</div>}
        </div>
      )}

      {loading ? (
        <div className="sc-empty">Loading…</div>
      ) : (
        <div className="sc-cols">
          <div className="sc-col">
            <div className="sc-sec-title">Counted ({counted.length})</div>
            {counted.length === 0 && <div className="sc-empty">Nothing scanned yet.</div>}
            {counted.map((l) => {
              const d = (l.counted_qty as number) - l.physical;
              return (
                <div key={l.line_id} className="sc-count-row">
                  <SkuImage status={imgMap[l.item_code]?.status} displayUrl={imgMap[l.item_code]?.displayUrl} name={l.name} size={32} />
                  <span className="ff-code">{l.item_code}</span>
                  <span className="ff-name">{l.name}</span>
                  <span className="sc-exp">was {l.physical}{l.added_missing ? ' · added' : ''}</span>
                  <span className="sc-ctlrow">
                    <button className="sc-step" onClick={() => void setQty(l.item_code, (l.counted_qty as number) - 1)}>−</button>
                    <input
                      type="number"
                      className="sc-qty"
                      min={0}
                      value={l.counted_qty as number}
                      onChange={(e) => void setQty(l.item_code, Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                    />
                    <button className="sc-step" onClick={() => void bump(l.item_code)}>+</button>
                  </span>
                  {d !== 0 && <span className={`sc-delta ${d > 0 ? 'pos' : 'neg'}`}>{d > 0 ? `+${d}` : d}</span>}
                </div>
              );
            })}
          </div>

          <div className="sc-col">
            <div className="sc-sec-title">Not yet scanned ({notScanned.length})</div>
            {notScanned.length === 0 && <div className="sc-empty">Everything in scope is scanned.</div>}
            {notScanned.map((l) => (
              <div key={l.line_id} className="sc-count-row dim">
                <SkuImage status={imgMap[l.item_code]?.status} displayUrl={imgMap[l.item_code]?.displayUrl} name={l.name} size={32} />
                <span className="ff-code">{l.item_code}</span>
                <span className="ff-name">{l.name}</span>
                <span className="sc-exp">system {l.physical}</span>
                <button className="btn-secondary sc-mini" onClick={() => void setQty(l.item_code, l.physical)}>= {l.physical}</button>
                <button className="btn-secondary sc-mini" onClick={() => void setQty(l.item_code, 0)}>0</button>
              </div>
            ))}
          </div>
        </div>
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

function CountAddHit({
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
