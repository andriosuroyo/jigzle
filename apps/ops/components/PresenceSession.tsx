'use client';

// Presence mode (docs/016 §2A; PR15/16; PR18 §5) — the phone "walk & confirm" pass (UI label:
// "Checkbox"), now QUANTITATIVE ("Scan without the scanner"). By-brand checklist; each row is image +
// SKU code (line 1) + name (line 2) + an EDITABLE Qty (default = expected) with −/+ + a ✓ "counted".
// Ticking commits the shown Qty (record_count set), exactly like Scan; editing the Qty auto-ticks;
// tap the ✓ again to un-tick (no collapse). An in-scope filter narrows the checklist; the shared
// SkuSearchAdd pulls in a SKU that's present but not listed. Close opens the SHARED CloseConfirm:
// a ticked row whose Qty ≠ expected writes (Qty − expected) — the SAME stock_check adjustment Scan
// writes (close engine 0024 §4b) — while un-ticked SKUs are NEVER auto-zeroed (set-0/leave at review).

import { useEffect, useMemo, useRef, useState } from 'react';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import CloseConfirm from '@/components/CloseConfirm';
import SkuSearchAdd from '@/components/SkuSearchAdd';
import {
  addMissingSku,
  cancelStockCheck,
  closeStockCheck,
  getSessionLines,
  recordCount,
  unconfirmPresent,
} from '@/app/stock-check/actions';
import { modeLabel, modeVerb } from '@/app/stock-check/types';
import type { CloseConfirmData, CloseReviewEntry, LineRow, SessionRow } from '@/app/stock-check/types';

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
  const [filter, setFilter] = useState(''); // in-scope filter (client-only) — distinct from the add-missing search

  const [confirm, setConfirm] = useState<CloseConfirmData | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeErr, setCloseErr] = useState<string | null>(null);
  const inflight = useRef<Set<Promise<unknown>>>(new Set()); // in-flight qty/untick writes; close awaits them so it reads a settled state

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

  // Tick / edit Qty = count this row at the shown Qty (record_count 'set'), exactly like Scan. Marks
  // confirmed=true so the close engine treats it as counted; tracked in inflight so Close awaits it.
  async function setQty(itemCode: string, qty: number) {
    setError(null);
    const v = Math.max(0, Math.floor(qty));
    const p = recordCount(session.stock_check_id, itemCode, 'set', v);
    inflight.current.add(p);
    try {
      await p;
      setLines((ls) => ls.map((l) => (l.item_code === itemCode ? { ...l, counted_qty: v, confirmed: true } : l)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Count failed.');
    } finally {
      inflight.current.delete(p);
    }
  }

  // Un-tick = back to un-counted (confirmed=false). counted_qty is left as-is on the row but the close
  // engine ignores it (§4b gates on confirmed); the un-ticked line flows through the set-0/leave review.
  async function untick(line: LineRow) {
    setError(null);
    setLines((ls) => ls.map((l) => (l.line_id === line.line_id ? { ...l, confirmed: false, counted_qty: null } : l)));
    const p = unconfirmPresent(line.line_id);
    inflight.current.add(p);
    try {
      await p;
    } catch (e) {
      // Roll back the optimistic clear fully — restore counted_qty too, not just confirmed, or the
      // row would show ticked-but-blank after a failed un-tick (L3).
      setLines((ls) => ls.map((l) => (l.line_id === line.line_id ? { ...l, confirmed: true, counted_qty: line.counted_qty } : l)));
      setError(e instanceof Error ? e.message : 'Update failed.');
    } finally {
      inflight.current.delete(p);
    }
  }

  async function add(code: string) {
    setError(null);
    try {
      await addMissingSku(session.stock_check_id, code, 1); // Presence add = present at qty 1
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Add failed.');
    }
  }

  async function openClose() {
    // The Qty field commits on blur; tapping Close blurs it, firing a setQty. Await any in-flight
    // write so the lines we close against include that last edit (no lost count). Then reload
    // authoritatively — the review must cover every server-side un-ticked line.
    if (inflight.current.size) await Promise.allSettled([...inflight.current]);
    const fresh = await reload();
    // Ticked rows whose Qty differs from the live shelf → (counted − expected), the SAME adjustment
    // Scan writes (close engine §4b). added-missing → flat +qty bucket; un-ticked → set-0/leave review.
    const countDeltas = fresh
      .filter((l) => l.confirmed && !l.added_missing && l.counted_qty != null && (l.counted_qty as number) - l.physical !== 0)
      .map((l) => ({ item_code: l.item_code, name: l.name, expected: l.physical, counted: l.counted_qty as number, delta: (l.counted_qty as number) - l.physical }));
    const added = fresh
      .filter((l) => l.added_missing)
      .map((l) => ({ item_code: l.item_code, name: l.name, qty: l.counted_qty ?? 0 }));
    const decisions = fresh
      .filter((l) => !l.confirmed && !l.added_missing)
      .map((l) => ({ item_code: l.item_code, name: l.name, expected: l.physical }));
    setConfirm({ mode: 'presence', countDeltas, decisions, added });
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

  const checked = lines.filter((l) => l.confirmed).length;
  const remaining = lines.filter((l) => !l.confirmed && !l.added_missing).length;
  const listed = useMemo(() => new Set(lines.map((l) => l.item_code)), [lines]);

  // in-scope filter applied to BOTH the to-check groups and the done list
  const f = filter.trim().toLowerCase();
  const matchF = (l: LineRow) => !f || l.item_code.toLowerCase().includes(f) || (l.name ?? '').toLowerCase().includes(f);

  // ticked rows STAY in place (PR16 §6) — no collapse-to-Done; group ALL lines by brand, in line order.
  // A ticked row renders done (greyed + checkmark) in its spot, checkbox still tappable to un-tick.
  const groups = useMemo(() => {
    const m = new Map<string, LineRow[]>();
    for (const l of lines) {
      if (!matchF(l)) continue;
      const k = l.brand_prefix ?? '—';
      const arr = m.get(k) ?? (m.set(k, []), m.get(k)!);
      arr.push(l);
    }
    // A–Z: items by item_code within each brand group (PR18 §3); groups A–Z by brand_prefix below.
    for (const arr of m.values()) arr.sort((a, b) => a.item_code.localeCompare(b.item_code));
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, f]);

  return (
    <div className="sc-wrap">
      <div className="sc-sess-head">
        <div className="sc-sess-row1">
          <button className="btn-link" onClick={onExit}>← back</button>
          <span className="sc-prog">{checked} / {lines.length} SKUs</span>
          <span className="sc-sess-actions">
            <button className="btn-link sc-danger" onClick={() => void doCancel()}>cancel</button>
            <button className="btn-primary" onClick={() => void openClose()} disabled={loading}>Close</button>
          </span>
        </div>
        <div className="sc-sess-row2">
          {modeLabel(session.mode)} · {session.scope === 'all_active' ? 'all active' : (session.scope_brands ?? []).join(', ')} · {modeVerb(session.mode)} {session.counted_by}
          {session.note ? ` · ${session.note}` : ''}
        </div>
      </div>

      {error && <div className="validation err" style={{ marginTop: 12 }}>{error}</div>}

      {/* Filter the checklist (find the SKU in hand) — separate from the add-missing search below. */}
      <div className="sc-filter">
        <input
          type="text"
          placeholder="Filter: search by code or name"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter && <button className="btn-link" onClick={() => setFilter('')}>clear</button>}
      </div>

      {/* Add a SKU that's here but not listed (autosearch → tap to add present). */}
      <SkuSearchAdd listed={listed} onSelect={(code) => void add(code)} />

      {loading ? (
        <div className="sc-empty">Loading the checklist…</div>
      ) : (
        <>
          {remaining === 0 && <div className="validation ok" style={{ marginTop: 12 }}>All checked — close when ready.</div>}
          {f && groups.length === 0 && <div className="sc-empty">No SKUs match.</div>}
          {groups.map(([brand, rows]) => (
            <div key={brand} className="sc-grp">
              <div className="sc-grp-head">{brand} <span className="sc-exp">({rows.length})</span></div>
              {rows.map((l) => (
                <CheckQtyRow key={l.line_id} line={l} imgMap={imgMap} onSet={setQty} onUntick={untick} />
              ))}
            </div>
          ))}
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

// One compact checklist row: image, code (line 1) / name (line 2), an editable Qty (default =
// expected) with −/+, the counted-vs-system delta, and the ✓ "counted". Ticking commits the shown
// Qty; editing the Qty auto-ticks; un-ticking returns the row to un-counted. The Qty is a local draft
// committed on blur/Enter (so a multi-digit count doesn't write per keystroke). added-missing rows
// are inherently counted: ✓ checked + disabled, Qty still editable to correct the added amount.
function CheckQtyRow({
  line,
  imgMap,
  onSet,
  onUntick,
}: {
  line: LineRow;
  imgMap: ReturnType<typeof useSkuImages>;
  onSet: (code: string, qty: number) => void;
  onUntick: (line: LineRow) => void;
}) {
  const counted = line.confirmed || line.added_missing; // "counted" = ticked, or an added line
  const expected = line.physical;                       // the default Qty the operator sees
  // draft: a counted/added row shows its number; an un-counted row is blank (placeholder = expected).
  const [draft, setDraft] = useState(counted ? String(line.counted_qty ?? expected) : '');
  useEffect(() => {
    setDraft(line.confirmed || line.added_missing ? String(line.counted_qty ?? expected) : '');
  }, [line.confirmed, line.counted_qty, line.added_missing, expected]);

  const base = line.counted_qty ?? expected;           // −/+ baseline (default expected before any count)
  const d = counted && line.counted_qty != null ? line.counted_qty - expected : 0;

  // parse the draft to a non-negative int; blank → the given fallback (used by the ✓ tap).
  function parsed(fallback: number): number {
    const t = draft.trim();
    if (t === '') return fallback;
    const n = Number(t);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
  }

  function commit() {
    const t = draft.trim();
    if (t === '') {
      // blank on a counted row → leave as-is (don't accidentally zero); un-counted stays un-counted.
      if (counted && line.counted_qty != null) setDraft(String(line.counted_qty));
      return;
    }
    const v = parsed(base);
    if (counted && v === line.counted_qty) return; // no change
    onSet(line.item_code, v); // commits + auto-ticks
  }

  function toggle(on: boolean) {
    if (line.added_missing) return; // an added line stays counted
    if (on) onSet(line.item_code, parsed(expected)); // ✓ → count at the typed Qty, or expected if blank
    else onUntick(line);
  }

  return (
    <div className={`sc-check-row2${counted ? ' done' : ''}`}>
      <SkuImage status={imgMap[line.item_code]?.status} displayUrl={imgMap[line.item_code]?.displayUrl} name={line.name} size={40} />
      <span className="sc-row-id">
        <span className="ff-code">{line.item_code}</span>
        <span className="ff-name">{line.name}</span>
      </span>
      {counted && d !== 0 && <span className={`sc-delta ${d > 0 ? 'pos' : 'neg'}`}>{d > 0 ? `+${d}` : d}</span>}
      <span className="sc-qtyctl">
        {/* onMouseDown preventDefault keeps focus in the field, so a stepper click doesn't also
            blur-commit the draft → exactly one deterministic write per action. */}
        <button className="sc-step" aria-label="minus one" onMouseDown={(e) => e.preventDefault()} onClick={() => onSet(line.item_code, base - 1)}>−</button>
        <input
          type="number"
          inputMode="numeric"
          className="sc-qty"
          min={0}
          placeholder={String(expected)}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
        />
        <button className="sc-step" aria-label="plus one" onMouseDown={(e) => e.preventDefault()} onClick={() => onSet(line.item_code, base + 1)}>+</button>
      </span>
      <input
        type="checkbox"
        aria-label="counted"
        checked={counted}
        disabled={line.added_missing}
        onChange={(e) => toggle(e.target.checked)}
      />
    </div>
  );
}
