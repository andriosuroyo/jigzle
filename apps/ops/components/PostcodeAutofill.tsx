'use client';

// Indonesia postcode autofill (PR98). A type-ahead over the local kelurahan dataset (lazy-loaded the
// first time it's focused). Picking a result hands the full match (province / city / kecamatan /
// kelurahan / postcode) back to the address overlay, which fills every field at once. Shown only for
// Indonesia addresses; the structured fields stay hand-editable afterward.

import { useEffect, useMemo, useRef, useState } from 'react';
import { loadPostal, searchPostal, type PostalData, type PostalHit } from '@/lib/idPostal';

export default function PostcodeAutofill({ onPick, disabled }: { onPick: (hit: PostalHit) => void; disabled?: boolean }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [data, setData] = useState<PostalData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // lazy-load the dataset on first focus
  function ensureLoaded() {
    if (data || loading) return;
    setLoading(true);
    setError(false);
    loadPostal()
      .then((d) => setData(d))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }

  // debounce the query (the dataset is ~81k rows; filter at most ~5×/sec while typing)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 180);
    return () => clearTimeout(t);
  }, [query]);

  // close the results when clicking outside
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const hits = useMemo(() => (data ? searchPostal(data, debounced, 40) : []), [data, debounced]);

  function pick(h: PostalHit) {
    onPick(h);
    setQuery('');
    setDebounced('');
    setOpen(false);
  }

  return (
    <div className="pc-autofill" ref={boxRef}>
      <input
        type="search"
        className="pc-autofill-input"
        placeholder="Find by kelurahan / kecamatan…"
        value={query}
        disabled={disabled}
        onFocus={() => { ensureLoaded(); setOpen(true); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
      />
      {open && (
        <div className="pc-results">
          {error && <div className="pc-hint">Couldn’t load postcode data — fill the fields by hand.</div>}
          {!error && loading && !data && <div className="pc-hint">Loading postcode data…</div>}
          {!error && data && debounced.trim().length < 2 && <div className="pc-hint">Type a kelurahan or kecamatan name.</div>}
          {!error && data && debounced.trim().length >= 2 && hits.length === 0 && <div className="pc-hint">No match — fill the fields by hand.</div>}
          {hits.map((h, i) => (
            <button type="button" key={`${h.postal}-${h.urban}-${i}`} className="pc-hit" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h)}>
              <span className="pc-hit-main">{h.urban}<span className="pc-hit-sub">{h.sub_district} · {h.city}</span></span>
              <span className="pc-hit-post">{h.postal}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
