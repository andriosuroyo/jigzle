'use client';

// The "active warehouse staff" selection (0052). Chosen in the Inbound/Outbound header and read back
// at record time by the boards, so the choice is stamped onto each receipt/shipment. Persisted in
// localStorage (per device — matches how a shared warehouse tablet is used: one person on shift), with
// a custom event so the header selector and any listeners stay in sync within a tab.

const KEY = 'jz_active_staff';
const EVENT = 'jz-active-staff';

export function getActiveStaff(): string | null {
  if (typeof window === 'undefined') return null;
  const v = window.localStorage.getItem(KEY);
  return v && v.trim() ? v : null;
}

export function setActiveStaff(name: string | null): void {
  if (typeof window === 'undefined') return;
  if (name && name.trim()) window.localStorage.setItem(KEY, name);
  else window.localStorage.removeItem(KEY);
  window.dispatchEvent(new CustomEvent(EVENT, { detail: name ?? null }));
}

// subscribe to changes (returns an unsubscribe). Fires on both same-tab custom events and cross-tab
// storage events so every mounted picker reflects the current choice.
export function onActiveStaffChange(cb: (name: string | null) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onCustom = (e: Event) => cb((e as CustomEvent).detail ?? null);
  const onStorage = (e: StorageEvent) => { if (e.key === KEY) cb(e.newValue && e.newValue.trim() ? e.newValue : null); };
  window.addEventListener(EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}
