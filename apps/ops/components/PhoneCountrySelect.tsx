'use client';

// PR159/PR322 — phone country picker for the Sales new-customer form. Now a thin wrapper over the shared
// DropSearch primitive: the compact button shows flag + dial code (🇮🇩 +62), the list shows the country
// name + dial, and search matches name OR code. value = the ISO country code (e.g. 'ID').

import { useMemo } from 'react';
import DropSearch from '@/components/DropSearch';
import { COUNTRIES, DIAL_CODES, flagOf } from '@/components/countries';

export default function PhoneCountrySelect({
  value,
  onChange,
  disabled = false,
}: {
  value: string; // ISO country code (e.g. 'ID')
  onChange: (code: string) => void;
  disabled?: boolean;
}) {
  const opts = useMemo(
    () => COUNTRIES.filter((c) => DIAL_CODES[c.code]).map((c) => ({
      value: c.code,
      label: `${c.name} +${DIAL_CODES[c.code]}`,
      buttonLabel: `+${DIAL_CODES[c.code]}`,
      icon: flagOf(c.code),
      search: `${c.name} +${DIAL_CODES[c.code]} ${DIAL_CODES[c.code]}`,
    })).sort((a, b) => a.label.localeCompare(b.label)),
    []
  );
  return (
    <DropSearch
      value={value || null}
      onChange={onChange}
      options={opts}
      className="phone-cc"
      ariaLabel="Country code"
      placeholder="—"
      disabled={disabled}
    />
  );
}
