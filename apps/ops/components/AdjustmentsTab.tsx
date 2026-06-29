'use client';

// Adjustments ledger (docs/016 §7). The signed-delta ledger that trues stock up to the shelf: filter
// by SKU / source / date, add a one-off manual adjustment, and edit/delete any row (override or undo
// an auto-written count delta). Edit/delete are direct RLS-gated table writes — no RPC.

import { useEffect, useMemo, useRef, useState } from 'react';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import {
  createManualAdjustment,
  deleteAdjustment,
  getAdjustments,
  searchSkus,
  updateAdjustment,
} from '@/app/stock-check/actions';
import type { AdjustmentFilter, AdjustmentRow, SkuHit } from '@/app/stock-check/types';

function fmt(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function AdjustmentsTab() {
  const [rows, setRows] = useState<AdjustmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [source, setSource] = useState<'all' | 'stock_check' | 'manual'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const [showNew, setShowNew] = useState(false);

  const [editId, setEditId] = useState<number | null>(null);
  const [editDelta, setEditDelta] = useState('');
  const [editNote, setEditNote] = useState('');

  const reqRef = useRef(0);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load(f?: AdjustmentFilter) {
    const myReq = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const r = await getAdjustments(f ?? { search, source, from: from || undefined, to: to || undefined });
      if (reqRef.current === myReq) setRows(r);
    } catch (e) {
      if (reqRef.current === myReq) setError(e instanceof Error ? e.message : 'Failed to load adjustments.');
    } finally {
      if (reqRef.current === myReq) setLoading(false);
    }
  }

  const imgCodes = useMemo(() => rows.map((r) => r.item_code), [rows]);
  const imgMap = useSkuImages(imgCodes);

  function applyFilters() {
    void load({ search, source, from: from || undefined, to: to || undefined });
  }
  // live filtering: debounce the text query and the date/source controls (empty query = show all).
  // Skip the very first run — the initial load already happened in the mount effect above.
  const firstFilter = useRef(true);
  useEffect(() => {
    if (firstFilter.current) { firstFilter.current = false; return; }
    const t = setTimeout(() => { applyFilters(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, source, from, to]);

  function startEdit(r: AdjustmentRow) {
    setEditId(r.adjustment_id);
    setEditDelta(String(r.delta));
    setEditNote(r.note ?? '');
  }
  async function saveEdit(id: number) {
    setError(null);
    const delta = Math.trunc(Number(editDelta));
    if (!Number.isInteger(delta) || delta === 0) {
      setError('Delta must be a non-zero whole number (delete to undo).');
      return;
    }
    try {
      await updateAdjustment(id, { delta, note: editNote });
      setEditId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed.');
    }
  }
  async function remove(id: number) {
    setError(null);
    try {
      await deleteAdjustment(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed.');
    }
  }

  return (
    <div className="sc-adj">
      <div className="sc-adj-bar">
        <input
          type="text"
          placeholder="search SKU code or name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyFilters(); } }}
        />
        <select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
          <option value="all">all sources</option>
          <option value="stock_check">stock check</option>
          <option value="manual">manual</option>
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} title="from" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} title="to" />
        <button className="btn-primary" onClick={() => setShowNew((v) => !v)}>+ Manual adjustment</button>
      </div>

      {showNew && <NewManual imgMap={imgMap} onDone={() => { setShowNew(false); void load(); }} onError={setError} />}

      {error && <div className="validation err" style={{ marginTop: 12 }}>{error}</div>}

      <div className="sc-adj-list">
        {!loading && rows.length === 0 && <div className="sc-empty">No adjustments match.</div>}
        {rows.map((r) =>
          editId === r.adjustment_id ? (
            <div key={r.adjustment_id} className="sc-adj-row editing">
              <span className="ff-code">{r.item_code}</span>
              <span className="ff-name">{r.name}</span>
              <input type="number" className="sc-qty" value={editDelta} onChange={(e) => setEditDelta(e.target.value)} />
              <input type="text" className="sc-note" placeholder="note" value={editNote} onChange={(e) => setEditNote(e.target.value)} />
              <button className="btn-primary sc-mini" onClick={() => void saveEdit(r.adjustment_id)}>save</button>
              <button className="btn-secondary sc-mini" onClick={() => setEditId(null)}>cancel</button>
            </div>
          ) : (
            <div key={r.adjustment_id} className="sc-adj-row">
              <SkuImage status={imgMap[r.item_code]?.status} displayUrl={imgMap[r.item_code]?.displayUrl} name={r.name} size={28} />
              <span className="ff-code">{r.item_code}</span>
              <span className="ff-name">{r.name}</span>
              <span className={`sc-delta ${r.delta >= 0 ? 'pos' : 'neg'}`}>{fmt(r.delta)}</span>
              <span className={`sc-src ${r.source}`}>{r.source === 'manual' ? 'manual' : 'count'}</span>
              <span className="sc-exp">{fmtDate(r.created_at)}</span>
              {r.note && <span className="sc-note-txt">{r.note}</span>}
              <button className="btn-link" onClick={() => startEdit(r)}>edit</button>
              <button className="btn-link sc-danger" onClick={() => void remove(r.adjustment_id)}>delete</button>
            </div>
          )
        )}
      </div>
    </div>
  );
}

// new manual adjustment: pick a SKU, signed delta, optional note
function NewManual({
  imgMap,
  onDone,
  onError,
}: {
  imgMap: ReturnType<typeof useSkuImages>;
  onDone: () => void;
  onError: (m: string) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SkuHit[]>([]);
  const [picked, setPicked] = useState<SkuHit | null>(null);
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const searchReq = useRef(0);

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
  // live SKU search: debounce the query and search as you type; clear below the 2-char floor
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); setSearching(false); return; }
    const t = setTimeout(() => { void doSearch(); }, 220);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  async function save() {
    if (!picked) return onError('Pick a SKU first.');
    const d = Math.trunc(Number(delta));
    if (!Number.isInteger(d) || d === 0) return onError('Enter a non-zero whole number (e.g. -2 or 5).');
    setSaving(true);
    try {
      await createManualAdjustment(picked.item_code, d, note);
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Save failed.');
      setSaving(false);
    }
  }

  return (
    <div className="sc-newadj">
      {picked ? (
        <div className="sc-newadj-picked">
          <SkuImage status={imgMap[picked.item_code]?.status} displayUrl={imgMap[picked.item_code]?.displayUrl} name={picked.name} size={28} />
          <span className="ff-code">{picked.item_code}</span>
          <span className="ff-name">{picked.name}</span>
          <button className="btn-link" onClick={() => setPicked(null)}>change</button>
          <input type="number" className="sc-qty" placeholder="±qty" value={delta} onChange={(e) => setDelta(e.target.value)} />
          <input type="text" className="sc-note" placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn-primary sc-mini" onClick={() => void save()} disabled={saving}>{saving ? 'saving…' : 'save'}</button>
        </div>
      ) : (
        <>
          <div className="sc-add">
            <input
              type="text"
              placeholder="search a SKU to adjust"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void doSearch(); } }}
            />
          </div>
          {hits.length > 0 && (
            <div className="sc-hits">
              {hits.map((h) => (
                <button key={h.item_code} className="sc-hit sc-hit-btn" onClick={() => { setPicked(h); setHits([]); }}>
                  <SkuImage status={imgMap[h.item_code]?.status} displayUrl={imgMap[h.item_code]?.displayUrl} name={h.name} size={28} />
                  <span className="ff-code">{h.item_code}</span>
                  <span className="ff-name">{h.name}</span>
                  <span className="sc-exp">avail {h.available}</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
