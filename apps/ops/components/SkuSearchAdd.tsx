'use client';

// Shared "search a SKU not on this list → tap to add" control for the Stock Check sessions
// (PR15 §A4). Autosearches as you type (debounced ~300ms — no button, no Enter-only trigger); tap a
// result to add it (no qty field — Count sets the qty in-list, Presence adds present at qty 1). A
// no-match routes to Catalog rather than inline-creating a SKU. Used by both PresenceSession and
// CountSession; the AdjustmentsTab / InboundBoard search copies are intentionally NOT shared.
// No write-path change: the parent still calls addMissingSku via onSelect; searchSkus is unchanged.

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import SkuImage from '@/components/SkuImage';
import { useSkuImages } from '@/components/useSkuImages';
import { searchSkus } from '@/app/stock-check/actions';
import type { SkuHit } from '@/app/stock-check/types';

const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;

export default function SkuSearchAdd({
  listed,
  placeholder,
  onSelect,
}: {
  listed: Set<string>;
  placeholder: string;
  onSelect: (code: string) => void;
}) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SkuHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(''); // the term `hits` reflect — gates the empty-state messages
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
  }

  return (
    <div className="sc-search">
      <div className="sc-add">
        <input type="text" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
        {searching && <span className="sc-exp">…</span>}
      </div>
      {fresh.length > 0 && (
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
      {allListed && <div className="sc-empty">All matches are already in this list.</div>}
      {noMatch && (
        <div className="sc-empty">
          Not in Catalog — <Link href="/catalog" className="btn-link">add it first</Link>
        </div>
      )}
    </div>
  );
}
