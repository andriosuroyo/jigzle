'use client';

// The active-staff selector shown as header subtext on Inbound + Outbound (0052). Picks who's on shift;
// the choice persists per device (staffStore) and is read back by the boards at record time so it's
// stamped onto each receipt/shipment. If no staff exist yet, it points to Settings.

import { useEffect, useState } from 'react';
import type { StaffMember } from '@/app/settings/types';
import { getActiveStaff, setActiveStaff, onActiveStaffChange } from '@/components/staffStore';

export default function StaffPicker({ options }: { options: StaffMember[] }) {
  const [active, setActive] = useState<string | null>(null);

  // hydrate from localStorage after mount (SSR has no window); default to the first staff if none set
  // and there's exactly one obvious choice is avoided — leave it explicit so nothing is mis-attributed.
  useEffect(() => {
    setActive(getActiveStaff());
    return onActiveStaffChange(setActive);
  }, []);

  function change(name: string) {
    const v = name || null;
    setActiveStaff(v);
    setActive(v);
  }

  if (options.length === 0) {
    return (
      <div className="staff-bar">
        <span className="staff-bar-label">Staff</span>
        <span className="hint">— add names in Settings → Inbound → Warehouse staff</span>
      </div>
    );
  }

  return (
    <div className="staff-bar">
      <span className="staff-bar-label">Staff</span>
      <select
        className="staff-bar-select"
        value={active ?? ''}
        onChange={(e) => change(e.target.value)}
        aria-label="Active warehouse staff"
      >
        <option value="">— none —</option>
        {options.map((s) => (
          <option key={s.id} value={s.label}>{s.icon ? `${s.icon} ` : ''}{s.label}</option>
        ))}
      </select>
    </div>
  );
}
