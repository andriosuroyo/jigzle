// Shared types for the SETTINGS module (PR25). Plain module (NO 'use server') so the actions file
// can export only async functions — a Next.js production-build requirement (the linux SWC on Vercel
// rejects a 'use server' module that exports anything but async functions, incl. interfaces).

// ── the three list-row shapes (NULL-only / global rows; user_id & created_at omitted — never
//    surfaced to the editor in this PR) ──
export interface PaymentMethod {
  id: number;
  label: string;
  is_active: boolean;
  sort_order: number;
}

export interface CourierService {
  id: number;
  courier: string;
  speed: string | null;
  label: string;
  is_active: boolean;
  sort_order: number;
}

export interface BoxPreset {
  id: number;
  code: string;
  dim_p: number | null;
  dim_l: number | null;
  dim_t: number | null;
  is_active: boolean;
  sort_order: number;
}

// PR28: the Inbound per-line label pick-list (same shape as PaymentMethod). Note: this REPLACES the
// old `InboundLabel` string-union in @jigzle/db/types (dropped — the stored label is now free text).
export interface InboundLabel {
  id: number;
  label: string;
  is_active: boolean;
  sort_order: number;
}

// 0035: the reusable shipment-note pick-list (gift wrap, free gift, …). Offered as a dropdown in the
// Pending/Fulfill note editor alongside free text. Same shape as PaymentMethod (label is the note text).
export interface CommonNote {
  id: number;
  label: string;
  is_active: boolean;
  sort_order: number;
}

// what getSettings() returns — one ordered, active-only list per kind.
export interface SettingsData {
  paymentMethods: PaymentMethod[];
  courierServices: CourierService[];
  boxPresets: BoxPreset[];
  inboundLabels: InboundLabel[];
  commonNotes: CommonNote[];
}

// discriminator threaded through the write actions (maps to a table server-side).
export type SettingsKind = 'payment' | 'courier' | 'box' | 'inbound_labels' | 'common_note';

export type SettingRow = PaymentMethod | CourierService | BoxPreset | InboundLabel | CommonNote;

// permissive payload shapes for add/update — the actions whitelist columns per kind, so a stray key
// can never reach an identity/system column (id / user_id / sort_order / created_at).
export type SettingPayload = Record<string, string | number | boolean | null>;
export type SettingPatch = Record<string, string | number | boolean | null>;
