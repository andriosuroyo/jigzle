'use client';

// PR159 — phone country picker for the Sales new-customer form. Like CountrySelect but the button
// shows flag + dial code (e.g. 🇮🇩 +62) and the list is searchable by country name OR code. value =
// the ISO country code (e.g. 'ID'); the parent combines dialOf(value) with the typed local number.

import { useEffect, useMemo, useRef, useState } from 'react';
import { COUNTRIES, DIAL_CODES, flagOf, dialOf } from '@/components/countries';

export default function PhoneCountrySelect({
  value,
  onChange,
  disabled = false,
}: {
  value: string; // ISO country code (e.g. 'ID')
  onChange: (code: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const opts = useMemo(
    () =>
      COUNTRIES.filter((c) => DIAL_CODES[c.code])
        .map((c) => ({ code: c.code, name: c.name, flag: flagOf(c.code), dial: DIAL_CODES[c.code] }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    []
  );
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase().replace(/^\+/, '');
    return s ? opts.filter((o) => o.name.toLowerCase().includes(s) || o.dial.startsWith(s)) : opts;
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
    <div className="flag-select phone-cc" ref={ref}>
      <button type="button" className="country-select-btn phone-cc-btn" disabled={disabled} aria-label="Country code" onClick={() => { setQ(''); setOpen((o) => !o); }}>
        <span className="country-select-val"><span className="flag-select-flag">{flagOf(value)}</span>+{dialOf(value)}</span>
        <span className="icon-select-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="flag-select-pop">
          <input className="flag-select-search" autoFocus placeholder="Search country or code…" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul className="flag-select-list">
            {filtered.map((o) => (
              <li key={o.code}>
                <button type="button" className={`flag-select-opt ${o.code === value ? 'active' : ''}`} onClick={() => { onChange(o.code); setOpen(false); }}>
                  <span className="flag-select-flag">{o.flag}</span>
                  <span className="phone-cc-name">{o.name}</span>
                  <span className="phone-cc-dial">+{o.dial}</span>
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
