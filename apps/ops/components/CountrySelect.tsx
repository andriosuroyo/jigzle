'use client';

// PR96/PR322 — country picker for the address overlay (addresses store the country NAME, e.g. "Indonesia").
// Now a thin wrapper over the shared DropSearch primitive (flag icon + name, searchable), so it matches
// every other dropdown. Value matching is case-tolerant so odd-cased legacy data still shows its country.

import { useMemo } from 'react';
import DropSearch from '@/components/DropSearch';
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
  const opts = useMemo(
    () => COUNTRIES.map((c) => ({ value: c.name, label: c.name, icon: flagOf(c.code) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    []
  );
  // canonicalise the stored value to the option's exact casing so it displays (legacy "indonesia" etc.)
  const canonical = value ? (opts.find((o) => o.value.toLowerCase() === value.toLowerCase())?.value ?? value) : null;

  return (
    <DropSearch
      value={canonical}
      onChange={onChange}
      options={opts}
      placeholder="— pick a country —"
      disabled={disabled}
      ariaLabel="Country"
    />
  );
}
