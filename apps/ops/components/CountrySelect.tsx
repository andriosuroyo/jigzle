'use client';

// PR96 — country picker for the address overlay. Like FlagSelect but the button shows flag + country
// NAME (addresses store the country name, not the flag), and the list is searchable. value = the
// country name (e.g. "Indonesia").

import { useEffect, useMemo, useRef, useState } from 'react';
import { COUNTRIES, flagOf } from '@/components/countries';

export default function CountrySelect({
  value,
  onChange,
  disabled = false,
}: {
  value: string | null;
  onChange: (country: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const opts = useMemo(
    () => COUNTRIES.map((c) => ({ name: c.name, flag: flagOf(c.code) })).sort((a, b) => a.name.localeCompare(b.name)),
    []
  );
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? opts.filter((o) => o.name.toLowerCase().includes(s)) : opts;
  }, [q, opts]);
  const selected = value ? opts.find((o) => o.name.toLowerCase() === value.toLowerCase()) ?? null : null;

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="flag-select country-select" ref={ref}>
      <button type="button" className="country-select-btn" disabled={disabled} onClick={() => { setQ(''); setOpen((o) => !o); }}>
        {selected ? (
          <span className="country-select-val"><span className="flag-select-flag">{selected.flag}</span>{selected.name}</span>
        ) : value ? (
          <span className="country-select-val">{value}</span>
        ) : (
          <span className="flag-select-ph-text">— pick a country —</span>
        )}
        <span className="icon-select-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="flag-select-pop">
          <input className="flag-select-search" autoFocus placeholder="Search country…" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="flag-select-list">
            {filtered.map((o) => (
              <li key={o.flag}>
                <button type="button" className={`flag-select-opt ${selected?.name === o.name ? 'active' : ''}`} onClick={() => { onChange(o.name); setOpen(false); }}>
                  <span className="flag-select-flag">{o.flag}</span><span>{o.name}</span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && <li className="flag-select-empty">No match</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
