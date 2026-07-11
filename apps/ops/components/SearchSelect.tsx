'use client';

// PR191/PR322 — a searchable single-value combobox over a flat string[] (e.g. every distinct Theme /
// Artist / Product-type across the catalogue). Now a thin wrapper over the shared DropSearch primitive
// so it looks + behaves like every other dropdown. `allowCreate` (default on) offers an inline "Add …"
// for a genuinely new value; clearing sets null. The guard against near-duplicate typos still holds —
// the operator PICKS an existing value rather than retyping it.

import DropSearch from '@/components/DropSearch';

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
  return (
    <DropSearch
      value={value}
      onChange={(v) => onChange(v || null)}
      options={options.map((o) => ({ value: o, label: o }))}
      placeholder={placeholder}
      disabled={disabled}
      clearable
      allowCreate={allowCreate}
    />
  );
}
