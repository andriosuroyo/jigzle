'use client';

// PR322 — "dropsearch": the ONE dropdown primitive. Opens to an auto-focused search box + filtered list,
// so you can type immediately (like the old Country picker). The search field appears when the list is
// longer than `searchThreshold` (default 8) OR `allowCreate` is on; short lists render as a plain dropdown.
// Keyboard: ↑/↓ move, Enter selects, Esc closes; without a search box a typed letter jumps to a match.
// Options carry an optional icon (any node). `clearable` adds a "— none —" row; `allowCreate` offers an
// "Add …" row for a value not in the list. Values are strings (callers stringify ids). CountrySelect /
// SearchSelect / IconSelect are thin wrappers over this, so every dropdown looks + behaves identically.

import { useEffect, useMemo, useRef, useState } from 'react';

// `buttonLabel` (when set, incl. '') is shown on the closed button instead of `label` — for compact
// pickers whose button is terser than their list rows (e.g. the phone code shows "+62", flag shows just
// the flag). `search` overrides what filtering matches against (else `label`).
export type DropOption = { value: string; label: string; icon?: React.ReactNode; buttonLabel?: string; search?: string };

export default function DropSearch({
  value,
  onChange,
  options,
  placeholder = '— pick —',
  disabled = false,
  searchThreshold = 8,
  clearable = false,
  allowCreate = false,
  ariaLabel,
  className,
}: {
  value: string | null;
  onChange: (value: string) => void;
  options: DropOption[];
  placeholder?: string;
  disabled?: boolean;
  searchThreshold?: number;
  clearable?: boolean;
  allowCreate?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // a leading "— none —" row when clearable, so the value can be unset from the list itself.
  const allOpts = useMemo(() => (clearable ? [{ value: '', label: '— none —' }, ...options] : options), [clearable, options]);
  const showSearch = allOpts.length > searchThreshold || allowCreate;
  // PR388 — if the stored value isn't in the options (e.g. the option lists haven't loaded yet, or the
  // value was retired from the managed list), still SHOW it on the closed button rather than the "— pick —"
  // placeholder, so a saved value never looks lost.
  const selected = useMemo(() => (value ? allOpts.find((o) => o.value === value) ?? { value, label: value } : null), [allOpts, value]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? allOpts.filter((o) => (o.search ?? o.label).toLowerCase().includes(s)) : allOpts;
  }, [q, allOpts]);
  const qTrim = q.trim();
  const canCreate = allowCreate && qTrim.length > 0 && !allOpts.some((o) => o.label.toLowerCase() === qTrim.toLowerCase());
  const navCount = filtered.length + (canCreate ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  function openMenu() {
    if (disabled) return;
    setQ('');
    setHi(Math.max(0, allOpts.findIndex((o) => o.value === value)));
    setOpen(true);
  }
  function choose(o: DropOption) { onChange(o.value); setOpen(false); }
  function create() { onChange(qTrim); setOpen(false); }

  useEffect(() => {
    if (!open || !listRef.current) return;
    (listRef.current.children[hi] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [hi, open]);

  function onKey(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); openMenu(); }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.min(navCount - 1, h + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (hi < filtered.length) { const o = filtered[hi]; if (o) choose(o); }
      else if (canCreate) create();
      return;
    }
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
          {selected ? (<>{selected.icon != null && <span className="ds-ico">{selected.icon}</span>}<span className="ds-label">{selected.buttonLabel ?? selected.label}</span></>)
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
              <li key={o.value || '__none__'}>
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  className={`ds-opt ${o.value === value ? 'active' : ''} ${i === hi ? 'hi' : ''} ${o.value === '' ? 'ds-none' : ''}`}
                  onMouseEnter={() => setHi(i)}
                  onClick={() => choose(o)}
                >
                  {o.icon != null && <span className="ds-ico">{o.icon}</span>}
                  <span className="ds-label">{o.label}</span>
                </button>
              </li>
            ))}
            {canCreate && (
              <li>
                <button
                  type="button"
                  className={`ds-opt ds-create ${filtered.length === hi ? 'hi' : ''}`}
                  onMouseEnter={() => setHi(filtered.length)}
                  onClick={create}
                >
                  Add “{qTrim}”
                </button>
              </li>
            )}
            {filtered.length === 0 && !canCreate && <li className="ds-empty">No match</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
