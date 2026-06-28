'use client';

// PR88 — compact flag picker for Settings → Suppliers. The button shows just the chosen flag (icon
// sized, empty when unset); the dropdown lists every country (flag + name, A–Z) with a search box.
// Picking one reports both the flag emoji (stored on the supplier) and the country name (derived).

import { useEffect, useMemo, useRef, useState } from 'react';
import { COUNTRIES, flagOf } from '@/components/countries';

export default function FlagSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: string | null; // the current flag emoji
  onChange: (sel: { flag: string; country: string }) => void;
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

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className="flag-select" ref={ref}>
      <button
        type="button"
        className="flag-select-btn"
        disabled={disabled}
        aria-label="Country flag"
        onClick={() => { setQ(''); setOpen((o) => !o); }}
      >
        {value ? <span className="flag-select-flag">{value}</span> : <span className="flag-select-ph" />}
      </button>

      {open && (
        <div className="flag-select-pop">
          <input
            className="flag-select-search"
            autoFocus
            placeholder="Search country…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <ul className="flag-select-list">
            {filtered.map((o) => (
              <li key={o.flag}>
                <button
                  type="button"
                  className={`flag-select-opt ${o.flag === value ? 'active' : ''}`}
                  onClick={() => { onChange({ flag: o.flag, country: o.name }); setOpen(false); }}
                >
                  <span className="flag-select-flag">{o.flag}</span>
                  <span>{o.name}</span>
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
