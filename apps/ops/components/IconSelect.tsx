'use client';

// PR85/PR322 — a dropdown that shows an icon (emoji OR uploaded image) beside each option. Now a thin
// wrapper over the shared DropSearch primitive, so it looks + behaves like every other dropdown (search
// auto-appears once the list is long). Generic over string|number values — callers keep their id types;
// we stringify for DropSearch and map back on pick. `className` still carries size variants (box-preset,
// channel widths, rcv-ctl) — their CSS now targets `.ds`.

import DropSearch from '@/components/DropSearch';

export type IconOption<V extends string | number> = { value: V; label: string; icon?: string | null };

// an icon string is an image when it's a URL or '/'-rooted path (a bundled brand SVG); else it's emoji/text.
const isIconUrl = (icon: string | null | undefined): boolean => !!icon && /^(https?:\/\/|\/)/.test(icon);
function OptionIcon({ icon }: { icon?: string | null }) {
  if (!icon) return null;
  return isIconUrl(icon)
    // eslint-disable-next-line @next/next/no-img-element -- static Storage CDN icon, off the data path
    ? <img className="ds-ico-img" src={icon} alt="" />
    : <span aria-hidden>{icon}</span>;
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
  const byStr = new Map(options.map((o) => [String(o.value), o.value] as const));
  const dsOpts = options.map((o) => ({ value: String(o.value), label: o.label, icon: o.icon ? <OptionIcon icon={o.icon} /> : undefined }));
  return (
    <DropSearch
      value={value != null ? String(value) : null}
      onChange={(v) => { const orig = byStr.get(v); if (orig !== undefined) onChange(orig); }}
      options={dsOpts}
      placeholder={placeholder}
      disabled={disabled}
      ariaLabel={ariaLabel}
      className={className}
    />
  );
}
