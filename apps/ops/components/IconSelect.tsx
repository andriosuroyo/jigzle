'use client';

// PR85 — a custom dropdown that shows an icon (emoji OR uploaded image) to the left of each option,
// which native <select>/<option> can't do. Used by the Settings-driven pickers (payment, courier,
// box preset, inbound label). Behaves like a select: a button shows the current choice; clicking it
// opens a listbox; picking an option or clicking outside closes it. Icons are optional per option.

import { useEffect, useRef, useState } from 'react';

export type IconOption<V extends string | number> = { value: V; label: string; icon?: string | null };

// an icon string is an uploaded image when it's a URL; otherwise it's a short emoji/text.
const isIconUrl = (icon: string | null | undefined): boolean => !!icon && /^https?:\/\//.test(icon);

function OptionIcon({ icon }: { icon?: string | null }) {
  if (!icon) return null;
  return isIconUrl(icon)
    // eslint-disable-next-line @next/next/no-img-element -- static Storage CDN icon, off the data path
    ? <img className="icon-select-ico" src={icon} alt="" />
    : <span className="icon-select-ico emoji" aria-hidden>{icon}</span>;
}

export default function IconSelect<V extends string | number>({
  value,
  options,
  onChange,
  placeholder = '— pick —',
  className = '',
  disabled = false,
  ariaLabel,
}: {
  value: V | null;
  options: IconOption<V>[];
  onChange: (value: V) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value) ?? null;

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div className={`icon-select ${open ? 'open' : ''} ${className}`} ref={ref}>
      <button
        type="button"
        className="icon-select-btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="icon-select-val">
          {selected ? (
            <>
              <OptionIcon icon={selected.icon} />
              <span className="icon-select-label">{selected.label}</span>
            </>
          ) : (
            <span className="icon-select-ph">{placeholder}</span>
          )}
        </span>
        <span className="icon-select-caret" aria-hidden>▾</span>
      </button>

      {open && (
        <ul className="icon-select-list" role="listbox">
          {options.map((o) => (
            <li key={String(o.value)} role="option" aria-selected={o.value === value}>
              <button
                type="button"
                className={`icon-select-opt ${o.value === value ? 'active' : ''}`}
                onClick={() => { onChange(o.value); setOpen(false); }}
              >
                <OptionIcon icon={o.icon} />
                <span className="icon-select-label">{o.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
