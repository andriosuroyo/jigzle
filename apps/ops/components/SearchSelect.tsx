'use client';

// PR191 — a searchable single-value combobox over a flat string[] of options (e.g. every distinct
// Theme / Artist / Product-type across the whole catalogue). A button shows the current value; opening
// it reveals a search box + the matching options, so an operator PICKS an existing value rather than
// retyping it — the guard against near-duplicate typos ("Mickey & Friend" vs "Mickey & Friends").
// allowCreate (default on) lets a genuinely new value be added inline; the parent persists it, so it
// re-appears in the option set on the next load.

import { useEffect, useMemo, useRef, useState } from 'react';

export default function SearchSelect({
  value,
  options,
  onChange,
  placeholder = '— pick —',
  disabled = false,
  allowCreate = true,
}: {
  value: string | null;
  options: string[];
  onChange: (v: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  allowCreate?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const base = s ? options.filter((o) => o.toLowerCase().includes(s)) : options;
    return base.slice(0, 60); // keep the list light even over thousands of themes
  }, [q, options]);
  const exact = options.some((o) => o.toLowerCase() === q.trim().toLowerCase());

  function commit(v: string | null) {
    onChange(v);
    setOpen(false);
    setQ('');
  }

  return (
    <div className={`ss ${disabled ? 'ss-disabled' : ''}`} ref={ref}>
      <button type="button" className="ss-btn" disabled={disabled} onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <span className={value ? 'ss-val' : 'ss-ph'}>{value || placeholder}</span>
        <span className="ss-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="ss-pop">
          <input
            autoFocus
            className="ss-search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            onKeyDown={(e) => { if (e.key === 'Enter' && allowCreate && q.trim() && !exact) { e.preventDefault(); commit(q.trim()); } }}
          />
          <ul className="ss-list" role="listbox">
            {value && <li><button type="button" className="ss-opt ss-clear" onClick={() => commit(null)}>Clear</button></li>}
            {filtered.map((o) => (
              <li key={o}><button type="button" className={`ss-opt ${o === value ? 'on' : ''}`} onClick={() => commit(o)}>{o}</button></li>
            ))}
            {allowCreate && q.trim() && !exact && (
              <li><button type="button" className="ss-opt ss-create" onClick={() => commit(q.trim())}>+ Add “{q.trim()}”</button></li>
            )}
            {filtered.length === 0 && !q.trim() && <li className="ss-empty">No values yet{allowCreate ? ' — type to add one' : ''}.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
