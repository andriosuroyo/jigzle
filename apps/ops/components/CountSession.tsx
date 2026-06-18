'use client';

// Count mode (docs/016 §2B; mobile rework docs/020) — phone-first quantitative count, no scanner
// required. Opens to the SKU list (scan is a collapsible optional tool); a filter box finds the SKU
// in hand; quantity entry is the primary control (type the real count, −/+ for corrections). One
// working list, un-counted first then counted, with a sticky progress header. Behavior-preserving:
// record_count / add_missing_sku / close_stock_check / CloseConfirm / BarcodePicker and the
// per-non-zero-delta adjustment write are all UNCHANGED — this reworks layout/ergonomics only.

import { useEffect, useMemo, useRef, useState } from 'react';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import BarcodePicker from '@/components/BarcodePicker';
import CloseConfirm from '@/components/CloseConfirm';
import SkuSearchAdd from '@/components/SkuSearchAdd';
import {
  addMissingSku,
  cancelStockCheck,
  closeStockCheck,
  getSessionLines,
  recordCount,
  resolveScan,
} from '@/app/stock-check/actions';
import type {
  CloseConfirmData,
  CloseReviewEntry,
  LineRow,
  ScanSku,
  SessionRow,
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
  const [scanOpen, setScanOpen] = useState(false); // collapsed by default (mobile-safe); opened on desktop

  const [filter, setFilter] = useState(''); // in-scope filter (client-only) — distinct from add-missing search

  const [confirm, setConfirm] = useState<CloseConfirmData | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeErr, setCloseErr] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const inflight = useRef<Set<Promise<unknown>>>(new Set()); // in-flight count writes; close awaits them so it reads a settled state

  useEffect(() => {
    void reload();
    // Desktop / fine-pointer (or a Bluetooth scanner): open the scan tool and focus it. Phones open
    // to the list — no keyboard popped, no auto-focus (docs/020 §4.1/§4.2).
    const fine = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer:fine)').matches;
    if (fine) setScanOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // focus the scan input only when the scan section is open (desktop load, or the operator opened it).
  useEffect(() => {
    if (scanOpen) inputRef.current?.focus();
  }, [scanOpen]);

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
    return [...set];
  }, [lines, picker]);
  const imgMap = useSkuImages(imgCodes);

  // increment a SKU by 1 (scan or +). Updates locally when the line exists; reloads when a brand-new
  // (out-of-scope) line was just created.
  async function bump(itemCode: string) {
    setError(null);
    const exists = lines.some((l) => l.item_code === itemCode);
    const p = recordCount(session.stock_check_id, itemCode, 'inc', 1);
    inflight.current.add(p);
    try {
      const newQty = await p;
      if (exists) {
        setLines((ls) => ls.map((l) => (l.item_code === itemCode ? { ...l, counted_qty: newQty, confirmed: true } : l)));
      } else {
        await reload();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Count failed.');
    } finally {
      inflight.current.delete(p);
    }
  }

  async function setQty(itemCode: string, qty: number) {
    setError(null);
    const v = Math.max(0, Math.floor(qty));
    const p = recordCount(session.stock_check_id, itemCode, 'set', v);
    inflight.current.add(p);
    try {
      await p;
      setLines((ls) => ls.map((l) => (l.item_code === itemCode ? { ...l, counted_qty: v, confirmed: true } : l)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed.');
    } finally {
      inflight.current.delete(p);
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

  async function addSku(code: string) {
    setError(null);
    try {
      await addMissingSku(session.stock_check_id, code, 1); // adds the line; operator sets the real qty in-list
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Add failed.');
    }
  }

  async function openClose() {
    // The qty field commits on blur; tapping Close blurs it, firing a setQty. Await any in-flight
    // count write to completion so the lines we close against include that last edit (no lost count,
    // even on a slow network). Close math/output below is unchanged from docs/016.
    if (inflight.current.size) await Promise.allSettled([...inflight.current]);
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
  const toCount = lines.filter((l) => l.counted_qty == null);
  const listed = useMemo(() => new Set(lines.map((l) => l.item_code)), [lines]);

  const f = filter.trim().toLowerCase();
  const matchF = (l: LineRow) => !f || l.item_code.toLowerCase().includes(f) || (l.name ?? '').toLowerCase().includes(f);
  const shownToCount = toCount.filter(matchF);
  const shownCounted = counted.filter(matchF);

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
        <div className="sc-prog">{counted.length} / {lines.length} SKUs</div>
        <button className="btn-link sc-danger" onClick={() => void doCancel()}>cancel</button>
        <button className="btn-primary" onClick={() => void openClose()} disabled={loading}>Close…</button>
      </div>

      {error && <div className="validation err" style={{ marginTop: 12 }}>{error}</div>}

      {/* Scan — optional, collapsible (desktop / Bluetooth scanner). Phones lead with the list. */}
      <div className="sc-scanbox">
        <button className="sc-scan-toggle" onClick={() => setScanOpen((v) => !v)} aria-expanded={scanOpen}>
          {scanOpen ? '▾' : '▸'} Scan (optional)
        </button>
        {scanOpen && (
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
        )}
      </div>

      {/* Filter the in-scope list (find the SKU in hand) — separate from add-missing search below. */}
      <div className="sc-filter">
        <input
          type="text"
          placeholder="filter this count — code or name"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter && <button className="btn-link" onClick={() => setFilter('')}>clear</button>}
      </div>

      {/* Add a SKU that's NOT in this count's scope (autosearch → tap to add at qty 1; set the real count in-list). */}
      <SkuSearchAdd listed={listed} placeholder="not in this count? search a code or name to add" onSelect={(code) => void addSku(code)} />

      {loading ? (
        <div className="sc-empty">Loading…</div>
      ) : (
        <div className="sc-list">
          <div className="sc-sec-title">To count ({toCount.length})</div>
          {shownToCount.length === 0 && (
            <div className="sc-empty">{toCount.length === 0 ? 'Everything in scope is counted.' : 'No matches in “to count”.'}</div>
          )}
          {shownToCount.map((l) => (
            <CountRow key={l.line_id} line={l} imgMap={imgMap} onSet={setQty} onInc={bump} />
          ))}

          <div className="sc-sec-title" style={{ marginTop: 16 }}>Counted ({counted.length})</div>
          {shownCounted.length === 0 && (
            <div className="sc-empty">{counted.length === 0 ? 'Nothing counted yet.' : 'No matches in “counted”.'}</div>
          )}
          {shownCounted.map((l) => (
            <CountRow key={l.line_id} line={l} imgMap={imgMap} onSet={setQty} onInc={bump} />
          ))}
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

// One working-list row (used for both un-counted and counted). The number field is the primary
// control: a local draft committed on blur/Enter, so typing a multi-digit count doesn't fire a write
// per keystroke (and doesn't move the row between sections mid-type). −/+ are small corrections; the
// quick "= system" / "0" buttons stay on un-counted rows.
function CountRow({
  line,
  imgMap,
  onSet,
  onInc,
}: {
  line: LineRow;
  imgMap: ReturnType<typeof useSkuImages>;
  onSet: (code: string, qty: number) => void;
  onInc: (code: string) => void;
}) {
  const counted = line.counted_qty != null;
  const [draft, setDraft] = useState(counted ? String(line.counted_qty) : '');
  useEffect(() => {
    setDraft(line.counted_qty == null ? '' : String(line.counted_qty));
  }, [line.counted_qty]);

  const d = counted ? (line.counted_qty as number) - line.physical : 0;

  function commit() {
    const t = draft.trim();
    if (t === '') return; // empty → leave as-is (an un-counted row stays un-counted)
    const n = Number(t);
    if (!Number.isFinite(n)) {
      setDraft(counted ? String(line.counted_qty) : '');
      return;
    }
    const v = Math.max(0, Math.floor(n));
    if (counted && v === line.counted_qty) return; // no change
    onSet(line.item_code, v);
  }

  return (
    <div className={`sc-count-row${counted ? '' : ' dim'}`}>
      <div className="sc-row-top">
        <SkuImage status={imgMap[line.item_code]?.status} displayUrl={imgMap[line.item_code]?.displayUrl} name={line.name} size={36} />
        <span className="sc-row-id">
          <span className="ff-code">{line.item_code}</span>
          <span className="ff-name">{line.name}</span>
        </span>
        {counted && d !== 0 && <span className={`sc-delta ${d > 0 ? 'pos' : 'neg'}`}>{d > 0 ? `+${d}` : d}</span>}
      </div>
      <div className="sc-row-ctl">
        {/* Scan: the editable qty field stands alone (PR16 §3) — no read-only label. The "= N" quick
            button (un-counted) and the delta badge (counted) carry the system-qty reference. */}
        <span className="sc-ctlrow">
          {/* onMouseDown preventDefault keeps focus in the qty field, so a stepper click doesn't also
              blur-commit the draft → exactly one deterministic write per action. */}
          <button className="sc-step" aria-label="minus one" onMouseDown={(e) => e.preventDefault()} onClick={() => onSet(line.item_code, (line.counted_qty ?? 0) - 1)}>−</button>
          <input
            type="number"
            inputMode="numeric"
            className="sc-qty"
            min={0}
            placeholder="count"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
          />
          <button className="sc-step" aria-label="plus one" onMouseDown={(e) => e.preventDefault()} onClick={() => onInc(line.item_code)}>+</button>
        </span>
        {!counted && (
          <span className="sc-quick">
            <button className="btn-secondary sc-mini" onMouseDown={(e) => e.preventDefault()} onClick={() => onSet(line.item_code, line.physical)}>= {line.physical}</button>
            <button className="btn-secondary sc-mini" onMouseDown={(e) => e.preventDefault()} onClick={() => onSet(line.item_code, 0)}>0</button>
          </span>
        )}
      </div>
    </div>
  );
}
