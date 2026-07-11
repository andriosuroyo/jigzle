'use client';

// PR88/PR322 — compact flag picker for Settings → Suppliers/Forwarders. Now a thin wrapper over the shared
// DropSearch primitive: the button shows just the flag (buttonLabel is blank), the list shows flag + name
// with a search box. value = the flag emoji stored on the row; picking reports { flag, country name }.

import { useMemo } from 'react';
import DropSearch from '@/components/DropSearch';
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
  const rows = useMemo(
    () => COUNTRIES.map((c) => ({ name: c.name, flag: flagOf(c.code) })).sort((a, b) => a.name.localeCompare(b.name)),
    []
  );
  const opts = useMemo(() => rows.map((r) => ({ value: r.name, label: r.name, buttonLabel: '', icon: r.flag })), [rows]);
  const current = value ? (rows.find((r) => r.flag === value)?.name ?? null) : null;

  return (
    <DropSearch
      value={current}
      onChange={(name) => { const r = rows.find((x) => x.name === name); if (r) onChange({ flag: r.flag, country: name }); }}
      options={opts}
      className="ds-flag"
      ariaLabel="Country flag"
      placeholder="—"
      disabled={disabled}
    />
  );
}
