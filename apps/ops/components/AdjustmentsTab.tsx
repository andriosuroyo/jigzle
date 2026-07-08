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
import SearchInput from '@/components/SearchInput';
import TrashButton from '@/components/TrashButton';
import { SKU_IMG } from '@/components/skuImageSizes';
import { isRealName } from '@/components/skuName';
import { PlusCircleIcon } from '@/components/AddIcons';

function fmt(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}
function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
const fmtDay = (iso: string): string => (iso || '').slice(0, 10) || '—'; // YYYY-MM-DD
const srcLabel = (s: AdjustmentRow['source']): string => (s === 'manual' ? 'manual' : s === 'reverse' ? 'reverse' : 'count');

// PR173 — brown pencil (edit) button, mirroring TrashButton's shape
function EditButton({ onClick, ariaLabel = 'Edit' }: { onClick: () => void; ariaLabel?: string }) {
  return (
    <button type="button" className="btn-edit" onClick={onClick} aria-label={ariaLabel} title={ariaLabel}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
      </svg>
    </button>
  );
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

  const [selId, setSelId] = useState<number | null>(null); // PR173: open bodyview
  const [confirmDel, setConfirmDel] = useState(false);
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
      setSelId(null); setConfirmDel(false); setEditId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed.');
    }
  }

  const sel = selId != null ? rows.find((r) => r.adjustment_id === selId) ?? null : null;
  const editing = sel != null && editId === sel.adjustment_id;
  const closeDetail = () => { setSelId(null); setEditId(null); setConfirmDel(false); };

  return (
    <div className="sc-adj">
      <div className="sc-adj-bar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="search SKU code or name"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyFilters(); } }}
        />
        {/* PR173: source + from + to on one row */}
        <div className="sc-adj-filters">
          <select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
            <option value="all">all sources</option>
            <option value="stock_check">stock check</option>
            <option value="manual">manual</option>
          </select>
          <span className="sc-adj-datewrap">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
            {!from && <span className="sc-adj-dateph">From date</span>}
          </span>
          <span className="sc-adj-datewrap">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
            {!to && <span className="sc-adj-dateph">To date</span>}
          </span>
        </div>
        <button className="btn-brown btn-ico sc-adj-newbtn" onClick={() => { setError(null); setShowNew(true); }}><PlusCircleIcon />Manual adjustment</button>
      </div>

      {/* PR175 — the whole new-adjustment flow (search SKU → set delta/note → save) lives in an overlay */}
      {showNew && (
        <div className="sc-modal-backdrop" onClick={() => setShowNew(false)}>
          <div className="sc-modal adj-modal" role="dialog" aria-modal="true" aria-label="New manual adjustment" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <span className="sc-modal-title">Manual adjustment</span>
              <button className="sc-modal-x" onClick={() => setShowNew(false)} aria-label="Close">×</button>
            </div>
            <div className="sc-modal-body">
              {error && <div className="validation err" style={{ marginBottom: 10 }}>{error}</div>}
              <NewManual imgMap={imgMap} onDone={() => { setShowNew(false); void load(); }} onError={setError} />
            </div>
          </div>
        </div>
      )}

      {!showNew && error && <div className="validation err" style={{ marginTop: 12 }}>{error}</div>}

      {/* PR173: compact 2-line quickview cards; tap for the bodyview (note + edit/delete) */}
      <div className="adj-cards">
        {!loading && rows.length === 0 && <div className="sc-empty">No adjustments match.</div>}
        {rows.map((r) => (
          <button key={r.adjustment_id} className="adj-card" onClick={() => setSelId(r.adjustment_id)}>
            <SkuImage status={imgMap[r.item_code]?.status} displayUrl={imgMap[r.item_code]?.displayUrl} name={r.name} size={SKU_IMG.sm} />
            <div className="adj-card-main">
              <div className="adj-card-l1">
                <span className="ff-code">{r.item_code}</span>
                <span className="adj-card-date">{fmtDay(r.created_at)}</span>
              </div>
              <div className="adj-card-l2">
                {isRealName(r.name, r.item_code) && <span className="ff-name">{r.name}</span>}
                <span className="adj-pills">
                  <span className={`sc-delta ${r.delta >= 0 ? 'pos' : 'neg'}`}>{fmt(r.delta)}</span>
                  <span className={`sc-src ${r.source}`}>{srcLabel(r.source)}</span>
                </span>
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* PR174 — the adjustment detail as an OVERLAY (few fields; no full bodyview) */}
      {sel && (
        <div className="sc-modal-backdrop" onClick={closeDetail}>
          <div className="sc-modal adj-modal" role="dialog" aria-modal="true" aria-label="Adjustment" onClick={(e) => e.stopPropagation()}>
            <div className="sc-modal-head sc-modal-head-row">
              <span className="sc-modal-title">{sel.item_code}</span>
              <button className="sc-modal-x" onClick={closeDetail} aria-label="Close">×</button>
            </div>
            <div className="sc-modal-body">
              {error && <div className="validation err" style={{ marginBottom: 10 }}>{error}</div>}
              <div className="adj-detail-head">
                <SkuImage status={imgMap[sel.item_code]?.status} displayUrl={imgMap[sel.item_code]?.displayUrl} name={sel.name} size={SKU_IMG.md} />
                <div className="adj-detail-main">
                  {isRealName(sel.name, sel.item_code) && <span className="ff-name">{sel.name}</span>}
                  <span className="adj-pills">
                    <span className={`sc-delta ${sel.delta >= 0 ? 'pos' : 'neg'}`}>{fmt(sel.delta)}</span>
                    <span className={`sc-src ${sel.source}`}>{srcLabel(sel.source)}</span>
                  </span>
                  <span className="hint">{fmtDate(sel.created_at)}</span>
                </div>
              </div>

              {editing ? (
                <div className="adj-edit">
                  <label className="adj-edit-f">Delta<input type="number" className="sc-qty" value={editDelta} onChange={(e) => setEditDelta(e.target.value)} /></label>
                  <label className="adj-edit-f adj-edit-note">Note<input type="text" value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="note" /></label>
                </div>
              ) : (
                <>
                  <div className="fd-section-head" style={{ marginTop: 14 }}>Note</div>
                  {sel.note ? <p className="order-note">{sel.note}</p> : <div className="hint">No note.</div>}
                </>
              )}
            </div>

            <div className="sc-modal-foot adj-modal-foot">
              {editing ? (
                <>
                  <button className="btn-secondary" onClick={() => setEditId(null)}>Cancel</button>
                  <button className="btn-primary" onClick={() => void saveEdit(sel.adjustment_id)}>Save</button>
                </>
              ) : confirmDel ? (
                <span className="rcv-reverse-ask">
                  Delete this adjustment? Stock will re-adjust.
                  <button className="btn-secondary" onClick={() => setConfirmDel(false)}>Cancel</button>
                  <button className="btn-primary danger" onClick={() => void remove(sel.adjustment_id)}>Yes, delete</button>
                </span>
              ) : (
                <div className="adj-actions">
                  <EditButton onClick={() => startEdit(sel)} />
                  <TrashButton onClick={() => setConfirmDel(true)} ariaLabel="Delete adjustment" />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
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
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder="search a SKU to adjust"
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
