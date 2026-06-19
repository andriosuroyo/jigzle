'use client';

// Shared "search a SKU not on this list → tap to add" control for the Stock Check sessions
// (PR15 §A4; PR18 §6). Autosearches as you type (debounced ~300ms); tap a result to add it (no qty
// field — Count sets the qty in-list, Presence adds present at qty 1). On a NO-MATCH it now offers an
// INLINE quick-add form (PR18 §6) — create a PARTIAL SKU (needs_review=true) and add it to the count
// without leaving the session (replaces PR15's link to /catalog). Used by both PresenceSession and
// CountSession; the parent still adds via onSelect (addMissingSku), so the write path is unchanged.

import { useEffect, useMemo, useRef, useState } from 'react';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { searchSkus } from '@/app/stock-check/actions';
import { getBarcodeOwners, quickAddSku } from '@/app/catalog/actions';
import { PRODUCT_TYPES } from '@/app/catalog/types';
import type { BarcodeOwner } from '@/app/catalog/types';
import type { SkuHit } from '@/app/stock-check/types';

const DEBOUNCE_MS = 300;
const MIN_CHARS = 3; // matches searchSkus' 3-char floor so the 0025 pg_trgm index is eligible (PR20)

export default function SkuSearchAdd({
  listed,
  placeholder = 'Add: list by code or name',
  onSelect,
}: {
  listed: Set<string>;
  placeholder?: string;
  onSelect: (code: string) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SkuHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(''); // the term `hits` reflect — gates the empty-state messages
  const [adding, setAdding] = useState(false); // the inline quick-add form is open
  const reqRef = useRef(0);
  const imgMap = useSkuImages(useMemo(() => hits.map((h) => h.item_code), [hits]));

  // autosearch: debounce, search as you type. Latest-wins so a slow response can't clobber a newer.
  useEffect(() => {
    const term = q.trim();
    if (term.length < MIN_CHARS) {
      setHits([]);
      setSearched('');
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      const myReq = ++reqRef.current;
      try {
        const r = await searchSkus(term);
        if (reqRef.current === myReq) {
          setHits(r);
          setSearched(term);
        }
      } catch {
        /* search failures are non-fatal */
      } finally {
        if (reqRef.current === myReq) setSearching(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q]);

  const term = q.trim();
  const fresh = hits.filter((h) => !listed.has(h.item_code));
  // only show an empty-state once the search for THIS exact term has settled (no pre-search flash)
  const settled = term.length >= MIN_CHARS && searched === term;
  const noMatch = settled && hits.length === 0;
  const allListed = settled && hits.length > 0 && fresh.length === 0;

  function select(code: string) {
    onSelect(code);
    setQ('');
    setHits([]);
    setAdding(false);
  }

  return (
    <div className="sc-search">
      <div className="sc-add">
        <input
          type="text"
          placeholder={placeholder}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setAdding(false); // editing the search reverts from the quick-add form
          }}
        />
        {searching && <span className="sc-exp">…</span>}
      </div>

      {!adding && fresh.length > 0 && (
        <div className="sc-hits">
          {fresh.map((h) => (
            <button key={h.item_code} className="sc-hit sc-hit-btn" onClick={() => select(h.item_code)}>
              <SkuImage status={imgMap[h.item_code]?.status} displayUrl={imgMap[h.item_code]?.displayUrl} name={h.name} size={32} />
              <span className="sc-row-id">
                <span className="ff-code">{h.item_code}</span>
                <span className="ff-name">{h.name}</span>
              </span>
              <span className="sc-exp">avail {h.available}</span>
            </button>
          ))}
        </div>
      )}

      {!adding && allListed && <div className="sc-empty">All matches are already in this list.</div>}

      {!adding && noMatch && (
        <div className="sc-empty sc-nomatch">
          Not in Catalog —{' '}
          <button className="btn-link" onClick={() => setAdding(true)}>add “{term}” as a new SKU</button>
        </div>
      )}

      {adding && (
        <QuickAddForm
          initialCode={term}
          onAdd={(code) => onSelect(code)}
          onClose={() => { setQ(''); setHits([]); setAdding(false); }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}

// Inline quick-add of a PARTIAL SKU (PR18 §6). Minimal fields: item_code (prefilled), name (required),
// product_type (required selector, no default), barcode (optional). A barcode that already resolves
// shows its owner SKU(s) — a soft warning (shared-barcode model), so staff either pick the existing
// SKU or create a new one that shares the code. On success the SKU is added to the count via onAdded.
function QuickAddForm({
  initialCode,
  onAdd,
  onClose,
  onCancel,
}: {
  initialCode: string;
  onAdd: (code: string) => void; // add the SKU to the count (does not close the form)
  onClose: () => void; // clear the search + close the form
  onCancel: () => void; // close the form without adding
}) {
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState('');
  const [ptype, setPtype] = useState('');
  const [barcode, setBarcode] = useState('');
  const [owners, setOwners] = useState<BarcodeOwner[]>([]);
  const [exists, setExists] = useState<{ item_code: string; name: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null); // soft post-add notice (e.g. barcode didn't link)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ownReq = useRef(0);

  // debounced shared-barcode owner lookup (informational; never blocks creation).
  useEffect(() => {
    const bc = barcode.trim();
    if (!bc) {
      setOwners([]);
      return;
    }
    const timer = setTimeout(async () => {
      const myReq = ++ownReq.current;
      try {
        const o = await getBarcodeOwners(bc);
        if (ownReq.current === myReq) setOwners(o);
      } catch {
        /* non-fatal */
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [barcode]);

  async function submit() {
    setErr(null);
    setExists(null);
    if (!code.trim()) return setErr('Item code is required.');
    if (!name.trim()) return setErr('Name is required.');
    if (!ptype) return setErr('Pick a product type.');
    setBusy(true);
    try {
      const res = await quickAddSku({ item_code: code.trim(), name: name.trim(), product_type: ptype, barcode: barcode.trim() || null });
      if (res.ok) {
        onAdd(res.item_code); // the SKU is created + joins the count either way
        if (res.barcodeWarning) setNotice(res.barcodeWarning); // stay open so the operator sees the soft warning
        else onClose();
        return;
      }
      if (res.reason === 'exists') setExists(res.existing);
      else setErr(res.message);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Add failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sc-quickadd">
      <div className="sc-qa-title">New SKU — partial, admin completes it later</div>

      <label className="sc-qa-field">
        <span>Item code</span>
        <input value={code} onChange={(e) => { setCode(e.target.value); setExists(null); }} placeholder="e.g. ACR-12345" />
      </label>
      <label className="sc-qa-field">
        <span>Name *</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="product name" />
      </label>
      <label className="sc-qa-field">
        <span>Product type *</span>
        <select value={ptype} onChange={(e) => setPtype(e.target.value)}>
          <option value="">Select…</option>
          {PRODUCT_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </label>
      <label className="sc-qa-field">
        <span>Barcode (optional)</span>
        <input value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder="scan / type, or leave blank" />
      </label>

      {owners.length > 0 && !notice && (
        <div className="sc-qa-warn">
          <span>⚠ Barcode already on {owners.length === 1 ? 'a SKU' : `${owners.length} SKUs`} — use it, or create a new SKU to share the code:</span>
          {owners.map((o) => (
            <button key={o.item_code} className="btn-link" onClick={() => { onAdd(o.item_code); onClose(); }}>
              use {o.item_code} · {o.name}
            </button>
          ))}
        </div>
      )}

      {exists && !notice && (
        <div className="sc-qa-warn">
          <span>⚠ {exists.item_code} already exists:</span>
          <button className="btn-link" onClick={() => { onAdd(exists.item_code); onClose(); }}>use {exists.name}</button>
        </div>
      )}

      {err && <div className="validation err" style={{ marginTop: 8 }}>{err}</div>}
      {notice && <div className="validation ok" style={{ marginTop: 8 }}>Added to the count — but {notice}.</div>}

      <div className="sc-qa-actions">
        {notice ? (
          <button className="btn-primary" onClick={onClose}>Done</button>
        ) : (
          <>
            <button className="btn-secondary" onClick={onCancel} disabled={busy}>cancel</button>
            <button className="btn-primary" onClick={submit} disabled={busy}>{busy ? 'Adding…' : 'Create & add to count'}</button>
          </>
        )}
      </div>
    </div>
  );
}
