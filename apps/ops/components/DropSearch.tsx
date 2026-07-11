'use client';

// PR322 — "dropsearch": a reusable dropdown that opens to an auto-focused search box + filtered list,
// so you can type immediately (like the Country picker). The search field only appears when the list is
// longer than `searchThreshold` (default 8) — short 2–4 option lists render as a plain dropdown. Keyboard:
// ↑/↓ move, Enter selects, Esc closes; when there's no search box, a typed letter jumps to a match.
// Values are strings (callers stringify ids / numbers). Visuals reuse the .ds-* styles in globals.css.

import { useEffect, useMemo, useRef, useState } from 'react';

export type DropOption = { value: string; label: string; icon?: React.ReactNode };

export default function DropSearch({
  value,
  onChange,
  options,
  placeholder = '— pick —',
  disabled = false,
  searchThreshold = 8,
  ariaLabel,
  className,
}: {
  value: string | null;
  onChange: (value: string) => void;
  options: DropOption[];
  placeholder?: string;
  disabled?: boolean;
  searchThreshold?: number;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0); // highlighted index into `filtered`
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const showSearch = options.length > searchThreshold;
  const selected = useMemo(() => options.find((o) => o.value === value) ?? null, [options, value]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => o.label.toLowerCase().includes(s)) : options;
  }, [q, options]);

  // close on outside click
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // when opening, reset the query and highlight the current selection
  function openMenu() {
    if (disabled) return;
    setQ('');
    const idx = Math.max(0, options.findIndex((o) => o.value === value));
    setHi(idx);
    setOpen(true);
  }
  function choose(o: DropOption) { onChange(o.value); setOpen(false); }

  // keep the highlighted row in view
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.children[hi] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  function onKey(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); openMenu(); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(filtered.length - 1, h + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); return; }
    if (e.key === 'Enter') { e.preventDefault(); const o = filtered[hi]; if (o) choose(o); return; }
    // type-ahead when there's no search box
    if (!showSearch && e.key.length === 1 && /\S/.test(e.key)) {
      const c = e.key.toLowerCase();
      const at = filtered.findIndex((o, i) => i > hi && o.label.toLowerCase().startsWith(c));
      const from0 = filtered.findIndex((o) => o.label.toLowerCase().startsWith(c));
      const next = at >= 0 ? at : from0;
      if (next >= 0) setHi(next);
    }
  }

  return (
    <div className={`ds ${open ? 'open' : ''} ${className ?? ''}`} ref={ref}>
      <button
        type="button"
        className="ds-btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKey}
      >
        <span className="ds-val">
          {selected ? (<>{selected.icon != null && <span className="ds-ico">{selected.icon}</span>}<span className="ds-label">{selected.label}</span></>)
            : <span className="ds-ph">{placeholder}</span>}
        </span>
        <span className="ds-caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="ds-pop">
          {showSearch && (
            <input
              className="ds-search"
              autoFocus
              placeholder="Search…"
              value={q}
              onChange={(e) => { setQ(e.target.value); setHi(0); }}
              onKeyDown={onKey}
            />
          )}
          <ul className="ds-list" role="listbox" aria-label={ariaLabel} ref={listRef}>
            {filtered.map((o, i) => (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  className={`ds-opt ${o.value === value ? 'active' : ''} ${i === hi ? 'hi' : ''}`}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => choose(o)}
                >
                  {o.icon != null && <span className="ds-ico">{o.icon}</span>}
                  <span className="ds-label">{o.label}</span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && <li className="ds-empty">No match</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
