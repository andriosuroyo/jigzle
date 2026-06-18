'use client';

// Presence mode (docs/016 §2A; PR15 §A) — the phone "walk & confirm" pass. By-brand checklist; each
// row is image + SKU code (line 1) + name (line 2) + expected qty + a ✓ "it's here". Ticking
// collapses the row into "done". An in-scope filter narrows the checklist; the shared SkuSearchAdd
// pulls in a SKU that's present but not listed. Close opens the SHARED CloseConfirm: un-ticked SKUs
// are NEVER auto-zeroed — each is set-to-0 or leave there. Tick/close behavior is unchanged.

import { useEffect, useMemo, useState } from 'react';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import CloseConfirm from '@/components/CloseConfirm';
import SkuSearchAdd from '@/components/SkuSearchAdd';
import {
  addMissingSku,
  cancelStockCheck,
  closeStockCheck,
  confirmPresent,
  getSessionLines,
  unconfirmPresent,
} from '@/app/stock-check/actions';
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
  const [showDone, setShowDone] = useState(false);
  const [filter, setFilter] = useState(''); // in-scope filter (client-only) — distinct from the add-missing search

  const [confirm, setConfirm] = useState<CloseConfirmData | null>(null);
  const [closing, setClosing] = useState(false);
  const [closeErr, setCloseErr] = useState<string | null>(null);

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

  const checked = lines.filter((l) => l.confirmed).length;
  const remaining = lines.filter((l) => !l.confirmed && !l.added_missing).length;
  const listed = useMemo(() => new Set(lines.map((l) => l.item_code)), [lines]);

  // in-scope filter applied to BOTH the to-check groups and the done list
  const f = filter.trim().toLowerCase();
  const matchF = (l: LineRow) => !f || l.item_code.toLowerCase().includes(f) || (l.name ?? '').toLowerCase().includes(f);

  const groups = useMemo(() => {
    const m = new Map<string, LineRow[]>();
    for (const l of lines) {
      if (l.confirmed || l.added_missing) continue;
      if (!matchF(l)) continue;
      const k = l.brand_prefix ?? '—';
      const arr = m.get(k) ?? (m.set(k, []), m.get(k)!);
      arr.push(l);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, f]);
  const shownDone = useMemo(() => lines.filter((l) => (l.confirmed || l.added_missing) && matchF(l)), [lines, f]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = lines.filter((l) => l.confirmed || l.added_missing);

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
        <div className="sc-prog">{checked} / {lines.length} SKUs</div>
        <button className="btn-link sc-danger" onClick={() => void doCancel()}>cancel</button>
        <button className="btn-primary" onClick={() => void openClose()} disabled={loading}>Close…</button>
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
          {f && groups.length === 0 && remaining > 0 && <div className="sc-empty">No un-checked SKUs match.</div>}
          {groups.map(([brand, rows]) => (
            <div key={brand} className="sc-grp">
              <div className="sc-grp-head">{brand} <span className="sc-exp">({rows.length})</span></div>
              {rows.map((l) => (
                <CheckRow key={l.line_id} line={l} imgMap={imgMap} onTick={tick} />
              ))}
            </div>
          ))}

          {done.length > 0 && (
            <div className="sc-grp">
              <button className="sc-grp-head sc-grp-toggle" onClick={() => setShowDone((v) => !v)}>
                {showDone ? '▾' : '▸'} Done <span className="sc-exp">({done.length})</span>
              </button>
              {showDone && shownDone.map((l) => <CheckRow key={l.line_id} line={l} imgMap={imgMap} onTick={tick} />)}
              {showDone && f && shownDone.length === 0 && <div className="sc-empty">No done SKUs match.</div>}
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

// One checklist row: image left, code (line 1) / name (line 2) stacked, expected/added + the ✓ on
// the right. The whole row is a <label> so tapping anywhere toggles the checkbox.
function CheckRow({
  line,
  imgMap,
  onTick,
}: {
  line: LineRow;
  imgMap: ReturnType<typeof useSkuImages>;
  onTick: (line: LineRow, on: boolean) => void;
}) {
  return (
    <label className={`sc-check-row${line.confirmed || line.added_missing ? ' done' : ''}`}>
      <SkuImage status={imgMap[line.item_code]?.status} displayUrl={imgMap[line.item_code]?.displayUrl} name={line.name} size={40} />
      <span className="sc-row-id">
        <span className="ff-code">{line.item_code}</span>
        <span className="ff-name">{line.name}</span>
      </span>
      {line.added_missing
        ? <span className="badge ready">+{line.counted_qty ?? 0} added</span>
        : <span className="sc-exp">Qty {line.physical}</span>}
      <input
        type="checkbox"
        checked={line.confirmed}
        disabled={line.added_missing}
        onChange={(e) => onTick(line, e.target.checked)}
      />
    </label>
  );
}
