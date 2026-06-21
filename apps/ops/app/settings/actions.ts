'use server';

// Server actions for the SETTINGS module (PR25). Same auth posture as the other modules: the SSR
// supabase client (anon key + the signed-in user's session), so RLS (is_allowed_user()) gates every
// read and write. The service-role key is never used here. All reads and writes target GLOBAL rows
// only (user_id is null) — the per-user override path (spec §6) is deliberately NOT built here.

import { createSupabaseServerClient } from '@jigzle/db/server';
import type {
  BoxPreset,
  CourierService,
  InboundLabel,
  PaymentMethod,
  SettingPatch,
  SettingPayload,
  SettingRow,
  SettingsData,
  SettingsKind,
} from './types';

// kind → table. The only place a kind becomes a table name.
const TABLE: Record<SettingsKind, string> = {
  payment: 'settings_payment_methods',
  courier: 'settings_courier_services',
  box: 'settings_box_presets',
  inbound_labels: 'settings_inbound_labels',
};

// editable columns per kind — anything outside this set is dropped before a write so a stray key can
// never touch an identity/system column (id / user_id / sort_order / created_at). is_active is set
// via updateSetting; sort_order via reorderSetting.
const WRITABLE: Record<SettingsKind, string[]> = {
  payment: ['label', 'is_active'],
  courier: ['courier', 'speed', 'label', 'is_active'],
  box: ['code', 'dim_p', 'dim_l', 'dim_t', 'is_active'],
  inbound_labels: ['label', 'is_active'],
};

function pick(kind: SettingsKind, src: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of WRITABLE[kind]) if (k in src && src[k] !== undefined) out[k] = src[k];
  return out;
}

// ── read: each list, global + active, ordered ──
export async function getSettings(): Promise<SettingsData> {
  const supabase = createSupabaseServerClient();

  async function list<T>(table: string): Promise<T[]> {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .is('user_id', null)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });
    if (error) throw new Error(`getSettings(${table}): ${error.message}`);
    return (data ?? []) as T[];
  }

  const [paymentMethods, courierServices, boxPresets, inboundLabels] = await Promise.all([
    list<PaymentMethod>(TABLE.payment),
    list<CourierService>(TABLE.courier),
    list<BoxPreset>(TABLE.box),
    list<InboundLabel>(TABLE.inbound_labels),
  ]);
  return { paymentMethods, courierServices, boxPresets, inboundLabels };
}

// ── lighter single-list reads (PR26: Fulfill needs couriers, Outbound box presets; PR27: Orders
//    Need-payment panel needs payment methods) ──
export async function getPaymentMethods(): Promise<PaymentMethod[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from(TABLE.payment)
    .select('*')
    .is('user_id', null)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`getPaymentMethods: ${error.message}`);
  return (data ?? []) as PaymentMethod[];
}

export async function getCourierServices(): Promise<CourierService[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from(TABLE.courier)
    .select('*')
    .is('user_id', null)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`getCourierServices: ${error.message}`);
  return (data ?? []) as CourierService[];
}

export async function getBoxPresets(): Promise<BoxPreset[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from(TABLE.box)
    .select('*')
    .is('user_id', null)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`getBoxPresets: ${error.message}`);
  return (data ?? []) as BoxPreset[];
}

// PR28: Inbound's per-line label picker reads this (mirrors how Fulfill reads courier services).
export async function getInboundLabels(): Promise<InboundLabel[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from(TABLE.inbound_labels)
    .select('*')
    .is('user_id', null)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`getInboundLabels: ${error.message}`);
  return (data ?? []) as InboundLabel[];
}

// ── add: a new global row at the end of its list (sort_order = current max + 1) ──
export async function addSetting(kind: SettingsKind, payload: SettingPayload): Promise<SettingRow> {
  const supabase = createSupabaseServerClient();
  const table = TABLE[kind];

  const { data: top } = await supabase
    .from(table)
    .select('sort_order')
    .is('user_id', null)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextOrder = ((top?.sort_order as number | null) ?? -1) + 1;

  const row = { ...pick(kind, payload), user_id: null, is_active: true, sort_order: nextOrder };
  const { data, error } = await supabase.from(table).insert(row).select('*').single();
  if (error) throw new Error(`addSetting(${kind}): ${error.message}`);
  return data as SettingRow;
}

// ── update: edit a global row's content / active flag (whitelisted columns only) ──
export async function updateSetting(kind: SettingsKind, id: number, patch: SettingPatch): Promise<SettingRow> {
  const supabase = createSupabaseServerClient();
  const upd = pick(kind, patch);
  if (Object.keys(upd).length === 0) throw new Error(`updateSetting(${kind}): nothing to update`);

  const { data, error } = await supabase
    .from(TABLE[kind])
    .update(upd)
    .eq('id', id)
    .is('user_id', null)
    .select('*')
    .single();
  if (error) throw new Error(`updateSetting(${kind}): ${error.message}`);
  return data as SettingRow;
}

// ── reorder: write sort_order = array index for each id (global rows only) ──
export async function reorderSetting(kind: SettingsKind, orderedIds: number[]): Promise<void> {
  if (!orderedIds.length) return;
  const supabase = createSupabaseServerClient();
  const table = TABLE[kind];

  const results = await Promise.all(
    orderedIds.map((id, i) =>
      supabase.from(table).update({ sort_order: i }).eq('id', id).is('user_id', null)
    )
  );
  const failed = results.find((r) => r.error);
  if (failed?.error) throw new Error(`reorderSetting(${kind}): ${failed.error.message}`);
}

// ── delete: soft delete (is_active = false) so a removed row keeps history and can be un-hidden ──
export async function deleteSetting(kind: SettingsKind, id: number): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from(TABLE[kind])
    .update({ is_active: false })
    .eq('id', id)
    .is('user_id', null);
  if (error) throw new Error(`deleteSetting(${kind}): ${error.message}`);
}
