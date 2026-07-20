'use server';

// Server actions for the SETTINGS module (PR25). Same auth posture as the other modules: the SSR
// supabase client (anon key + the signed-in user's session), so RLS (is_allowed_user()) gates every
// read and write. The service-role key is never used here. All reads and writes target GLOBAL rows
// only (user_id is null) — the per-user override path (spec §6) is deliberately NOT built here.

import { createSupabaseServerClient } from '@jigzle/db/server';
import type {
  BoxPreset,
  CatalogClassOption,
  ChannelOption,
  CommonNote,
  CnAddress,
  CourierService,
  DeclarationUser,
  ExportCourier,
  SearchAlias,
  LocalCourier,
  PaymentMethod,
  ShipmentCourier,
  SettingPatch,
  SettingPayload,
  SettingRow,
  SettingsData,
  SettingsKind,
  StaffMember,
} from './types';

// kind → table. The only place a kind becomes a table name.
const TABLE: Record<SettingsKind, string> = {
  payment: 'settings_payment_methods',
  courier: 'settings_courier_services',
  box: 'settings_box_presets',
  common_note: 'settings_common_notes',
  channel: 'settings_customer_channels',
  staff: 'settings_staff',
  local_courier: 'settings_local_couriers',
  ship_courier: 'settings_shipment_couriers',
  cat_product_type: 'settings_catalog_product_types',
  cat_sub_type: 'settings_catalog_sub_types',
  cat_piece_type: 'settings_catalog_piece_types',
  cat_effect: 'settings_catalog_effects',
};

// editable columns per kind — anything outside this set is dropped before a write so a stray key can
// never touch an identity/system column (id / user_id / sort_order / created_at). is_active is set
// via updateSetting; sort_order via reorderSetting.
const WRITABLE: Record<SettingsKind, string[]> = {
  payment: ['label', 'icon', 'is_active'],
  courier: ['courier', 'speed', 'label', 'icon', 'is_active'],
  box: ['code', 'dim_p', 'dim_l', 'dim_t', 'icon', 'is_active'],
  common_note: ['label', 'icon', 'is_active'],
  channel: ['label', 'icon', 'is_active'],
  staff: ['label', 'icon', 'is_active'],
  local_courier: ['label', 'icon', 'flag', 'country', 'prefix', 'is_active'],
  ship_courier: ['label', 'icon', 'flag', 'country', 'prefix', 'is_active'],
  cat_product_type: ['label', 'icon', 'is_active'],
  cat_sub_type: ['label', 'icon', 'is_active', 'product_type'], // PR368 — sub type ↔ product type link (0097)
  cat_piece_type: ['label', 'icon', 'is_active'],
  cat_effect: ['label', 'icon', 'is_active', 'category'], // PR391 — effect + hidden category (0115)
};

// uploaded-icon storage (public-read bucket, like sku-images). 0041 creates the bucket + RLS.
const ICON_BUCKET = 'settings-icons';

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

  // staff (0052) degrades to [] if the table isn't applied yet, so Settings still loads.
  async function listSafe<T>(table: string): Promise<T[]> {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .is('user_id', null)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });
    if (error) return [];
    return (data ?? []) as T[];
  }

  const [paymentMethods, courierServices, boxPresets, commonNotes, channels, staff, localCouriers, shipmentCouriers, catProductTypes, catSubTypes, catPieceTypes, catEffects] = await Promise.all([
    list<PaymentMethod>(TABLE.payment),
    list<CourierService>(TABLE.courier),
    list<BoxPreset>(TABLE.box),
    list<CommonNote>(TABLE.common_note),
    list<ChannelOption>(TABLE.channel),
    listSafe<StaffMember>(TABLE.staff),
    listSafe<LocalCourier>(TABLE.local_courier), // 0055 — degrades to [] until the migration is applied
    listSafe<ShipmentCourier>(TABLE.ship_courier), // 0056 — same degrade
    listSafe<CatalogClassOption>(TABLE.cat_product_type), // 0059 — degrades to [] until applied
    listSafe<CatalogClassOption>(TABLE.cat_sub_type),
    listSafe<CatalogClassOption>(TABLE.cat_piece_type),
    listSafe<CatalogClassOption>(TABLE.cat_effect), // 0115 — degrades to [] until applied
  ]);
  return { paymentMethods, courierServices, boxPresets, commonNotes, channels, staff, localCouriers, shipmentCouriers, catProductTypes, catSubTypes, catPieceTypes, catEffects };
}

// PR371 — usage counts for the Catalog classification pick-lists (Settings badges): how many SKUs use
// each Product type / Piece type (by label) and each Sub type (by product_type + label pair). One
// bounded-concurrency paged scan of the three columns; lazily loaded when the Catalog category opens.
// Degrades to empty maps on any error (badges just don't show). Sub-type key = `${pt}${label}`.
export async function getCatalogClassUsage(): Promise<{ product: Record<string, number>; sub: Record<string, number>; piece: Record<string, number> }> {
  const supabase = createSupabaseServerClient();
  const product: Record<string, number> = {};
  const sub: Record<string, number> = {};
  const piece: Record<string, number> = {};
  try {
    const { count } = await supabase.from('catalogue').select('item_code', { count: 'exact', head: true });
    const total = count ?? 0;
    const PAGE = 1000;
    const pages = Math.ceil(total / PAGE);
    const CONC = 8;
    for (let start = 0; start < pages; start += CONC) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(CONC, pages - start) }, (_, k) => {
          const from = (start + k) * PAGE;
          return supabase.from('catalogue').select('product_type,sub_type,piece_type').order('item_code').range(from, from + PAGE - 1);
        }),
      );
      for (const { data } of batch)
        for (const r of (data ?? []) as { product_type: string | null; sub_type: string | null; piece_type: string | null }[]) {
          const pt = (r.product_type ?? '').trim();
          const st = (r.sub_type ?? '').trim();
          const pc = (r.piece_type ?? '').trim();
          if (pt) product[pt] = (product[pt] ?? 0) + 1;
          if (st) { const key = pt + '|' + st; sub[key] = (sub[key] ?? 0) + 1; } // '|' never appears in a type label
          if (pc) piece[pc] = (piece[pc] ?? 0) + 1;
        }
    }
  } catch { /* degrade to whatever was counted */ }
  return { product, sub, piece };
}

// 0056: Purchasing History's shipment-courier pick-list (degrades to [] until 0056 is applied).
export async function getShipmentCouriers(): Promise<ShipmentCourier[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from(TABLE.ship_courier)
    .select('*')
    .is('user_id', null)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) return [];
  return (data ?? []) as ShipmentCourier[];
}

// 0055: Purchasing To-forwarder's local-courier suggestions (mirrors getStaffOptions' degrade-to-[]).
export async function getLocalCouriers(): Promise<LocalCourier[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from(TABLE.local_courier)
    .select('*')
    .is('user_id', null)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) return [];
  return (data ?? []) as LocalCourier[];
}

// The Inbound/Outbound header staff picker reads this (mirrors getChannelOptions). Degrades to [] if
// the table isn't present yet (0052 not applied), so the picker just shows no staff.
export async function getStaffOptions(): Promise<StaffMember[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from(TABLE.staff)
    .select('*')
    .is('user_id', null)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) return [];
  return (data ?? []) as StaffMember[];
}

// the Customer detail's Channels picker reads this (mirrors how Fulfill reads courier services). Degrades
// to [] if the table isn't present yet (0046 not applied), so the picker just shows no platform icons.
export async function getChannelOptions(): Promise<ChannelOption[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from(TABLE.channel)
    .select('*')
    .is('user_id', null)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) return [];
  return (data ?? []) as ChannelOption[];
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

// 0035: the Pending/Fulfill note editor reads this for its common-note dropdown.
export async function getCommonNotes(): Promise<CommonNote[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from(TABLE.common_note)
    .select('*')
    .is('user_id', null)
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`getCommonNotes: ${error.message}`);
  return (data ?? []) as CommonNote[];
}

// PR145: the Couriers editor edits only the label, which used to leave the structured `courier`
// column '' on new rows — and Fulfill's Send to Outbound refuses an empty courier (the error surfaced
// as Next's masked production banner). Keep courier/speed derived from the label on every write
// (first word = base courier, rest = speed tier) so a courier row is shippable by construction.
function withCourierSync(kind: SettingsKind, upd: Record<string, unknown>): Record<string, unknown> {
  if (kind !== 'courier') return upd;
  const label = typeof upd.label === 'string' ? upd.label.trim() : '';
  if (!label) return upd;
  const [courier, ...rest] = label.split(/\s+/);
  return { ...upd, courier, speed: rest.length ? rest.join(' ') : null };
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

  const row = { ...withCourierSync(kind, pick(kind, payload)), user_id: null, is_active: true, sort_order: nextOrder };
  const { data, error } = await supabase.from(table).insert(row).select('*').single();
  if (error) throw new Error(`addSetting(${kind}): ${error.message}`);
  return data as SettingRow;
}

// ── update: edit a global row's content / active flag (whitelisted columns only) ──
export async function updateSetting(kind: SettingsKind, id: number, patch: SettingPatch): Promise<SettingRow> {
  const supabase = createSupabaseServerClient();
  const upd = withCourierSync(kind, pick(kind, patch));
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

// ── PR84: upload an icon image → public Storage URL. The client passes the file in a FormData; we
// write it to the public `settings-icons` bucket (RLS: allowed users only) and return its public URL,
// which the caller then stores in the row's `icon` column via updateSetting. ──
const ICON_MAX_BYTES = 2 * 1024 * 1024; // 2 MB — icons are tiny; reject anything larger
export async function uploadSettingIcon(form: FormData): Promise<{ url: string }> {
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) throw new Error('uploadSettingIcon: no file');
  if (file.size > ICON_MAX_BYTES) throw new Error('uploadSettingIcon: image too large (max 2 MB)');
  if (!file.type.startsWith('image/')) throw new Error('uploadSettingIcon: not an image');

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) throw new Error('uploadSettingIcon: storage URL not configured');

  const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  // a stable-ish unique path; no Math.random/Date in scope concerns here (server action, not a workflow)
  const path = `${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`;

  const supabase = createSupabaseServerClient();
  const { error } = await supabase.storage.from(ICON_BUCKET).upload(path, file, {
    contentType: file.type,
    cacheControl: '31536000',
    upsert: false,
  });
  if (error) throw new Error(`uploadSettingIcon: ${error.message}`);

  return { url: `${base}/storage/v1/object/public/${ICON_BUCKET}/${path}` };
}

// ── 0066 (PR191): export couriers — the Fulfill/international pick-list, with an optional intermediary
// address. GLOBAL rows only (user_id null), same posture as the other Settings lists. getExportCouriers
// degrades to [] until 0066 is applied. ──
const EXPORT_COLS = 'id,label,icon,is_active,needs_address,addr_recipient,addr_phone,addr_text,sort_order';

export async function getExportCouriers(): Promise<ExportCourier[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('settings_export_couriers')
    .select(EXPORT_COLS)
    .is('user_id', null)
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });
  if (error) return []; // table not yet created → degrade
  return (data ?? []) as ExportCourier[];
}

type ExportCourierInput = {
  label: string;
  needs_address?: boolean;
  addr_recipient?: string | null;
  addr_phone?: string | null;
  addr_text?: string | null;
};

export async function addExportCourier(input: ExportCourierInput): Promise<ExportCourier> {
  const supabase = createSupabaseServerClient();
  const label = input.label.trim();
  if (!label) throw new Error('A courier name is required.');
  const { data: maxRow } = await supabase.from('settings_export_couriers').select('sort_order').is('user_id', null).order('sort_order', { ascending: false }).limit(1).maybeSingle();
  const sort_order = ((maxRow?.sort_order as number | null) ?? -1) + 1;
  const { data, error } = await supabase
    .from('settings_export_couriers')
    .insert({ user_id: null, label, needs_address: !!input.needs_address, addr_recipient: input.addr_recipient ?? null, addr_phone: input.addr_phone ?? null, addr_text: input.addr_text ?? null, sort_order })
    .select(EXPORT_COLS)
    .single();
  if (error) throw new Error(error.message);
  return data as ExportCourier;
}

export async function updateExportCourier(id: number, patch: Partial<Pick<ExportCourier, 'label' | 'icon' | 'is_active' | 'needs_address' | 'addr_recipient' | 'addr_phone' | 'addr_text'>>): Promise<ExportCourier> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.from('settings_export_couriers').update(patch).eq('id', id).select(EXPORT_COLS).single();
  if (error) throw new Error(error.message);
  return data as ExportCourier;
}

export async function deleteExportCourier(id: number): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from('settings_export_couriers').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function reorderExportCouriers(ids: number[]): Promise<void> {
  const supabase = createSupabaseServerClient();
  await Promise.all(ids.map((id, i) => supabase.from('settings_export_couriers').update({ sort_order: i }).eq('id', id)));
}

// ── 0095 (PR356): CN document addresses — one Settings list shared by the CN Invoice shipper AND
// consignee selectors. GLOBAL rows only (user_id null); getCnAddresses degrades to [] until applied. ──
const CN_ADDR_COLS = 'id,label,address,is_active,sort_order';

export async function getCnAddresses(): Promise<CnAddress[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('settings_cn_addresses')
    .select(CN_ADDR_COLS)
    .is('user_id', null)
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });
  if (error) return []; // table not yet created → degrade
  return (data ?? []) as CnAddress[];
}

export async function addCnAddress(input: { label: string; address?: string }): Promise<CnAddress> {
  const supabase = createSupabaseServerClient();
  const label = input.label.trim();
  if (!label) throw new Error('A label is required.');
  const { data: maxRow } = await supabase.from('settings_cn_addresses').select('sort_order').is('user_id', null).order('sort_order', { ascending: false }).limit(1).maybeSingle();
  const sort_order = ((maxRow?.sort_order as number | null) ?? -1) + 1;
  const { data, error } = await supabase
    .from('settings_cn_addresses')
    .insert({ user_id: null, label, address: input.address ?? '', sort_order })
    .select(CN_ADDR_COLS)
    .single();
  if (error) throw new Error(error.message);
  return data as CnAddress;
}

export async function updateCnAddress(id: number, patch: Partial<Pick<CnAddress, 'label' | 'address' | 'is_active'>>): Promise<CnAddress> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.from('settings_cn_addresses').update(patch).eq('id', id).select(CN_ADDR_COLS).single();
  if (error) throw new Error(error.message);
  return data as CnAddress;
}

export async function deleteCnAddress(id: number): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from('settings_cn_addresses').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function reorderCnAddresses(ids: number[]): Promise<void> {
  const supabase = createSupabaseServerClient();
  await Promise.all(ids.map((id, i) => supabase.from('settings_cn_addresses').update({ sort_order: i }).eq('id', id)));
}

// ── 0068 (PR205): declaration users — the SP Declare (Surat Pernyataan) identity pick-list. GLOBAL
// rows only, same posture as the other lists. getDeclarationUsers degrades to [] until 0068 is applied. ──
const DECL_COLS = 'id,name,ktp,npwp,phone,address,sort_order';

export async function getDeclarationUsers(): Promise<DeclarationUser[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('settings_declaration_users')
    .select(DECL_COLS)
    .is('user_id', null)
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) return []; // table not yet created → degrade
  return (data ?? []) as DeclarationUser[];
}

export async function addDeclarationUser(name: string): Promise<DeclarationUser> {
  const supabase = createSupabaseServerClient();
  const nm = name.trim();
  if (!nm) throw new Error('A name is required.');
  const { data: maxRow } = await supabase.from('settings_declaration_users').select('sort_order').is('user_id', null).order('sort_order', { ascending: false }).limit(1).maybeSingle();
  const sort_order = ((maxRow?.sort_order as number | null) ?? -1) + 1;
  const { data, error } = await supabase
    .from('settings_declaration_users')
    .insert({ user_id: null, name: nm, sort_order })
    .select(DECL_COLS)
    .single();
  if (error) throw new Error(error.message);
  return data as DeclarationUser;
}

export async function updateDeclarationUser(id: number, patch: Partial<Pick<DeclarationUser, 'name' | 'ktp' | 'npwp' | 'phone' | 'address'>>): Promise<DeclarationUser> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.from('settings_declaration_users').update(patch).eq('id', id).select(DECL_COLS).single();
  if (error) throw new Error(error.message);
  return data as DeclarationUser;
}

export async function deleteDeclarationUser(id: number): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from('settings_declaration_users').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function reorderDeclarationUsers(ids: number[]): Promise<void> {
  const supabase = createSupabaseServerClient();
  await Promise.all(ids.map((id, i) => supabase.from('settings_declaration_users').update({ sort_order: i }).eq('id', id)));
}

// ── 0087/0088 (PR344): search aliases — searching a `term` also matches items containing `alias`, so you
// can find by character/series/franchise without knowing the SKU's exact wording. Read by the search_skus
// RPC; curated in Settings → Catalog → Search aliases. Stored lowercase (the RPC matches case-insensitively;
// keeping the store lowercase makes the list tidy and the (term, alias) PK dedupe reliably). All reads/writes
// go through RLS (is_allowed_user()); getSearchAliases degrades to [] until 0087 is applied. ──
export async function getSearchAliases(): Promise<SearchAlias[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('search_aliases')
    .select('term,alias')
    .order('term', { ascending: true })
    .order('alias', { ascending: true });
  if (error) return []; // table not yet created → degrade
  return (data ?? []) as SearchAlias[];
}

// add a term→alias pair (+ optionally its reverse). Returns every row actually inserted (skips any that
// already existed) so the caller can append them. Returns { error } for expected failures, never throws.
// PR379 — Settings → Catalog → Brand logos. A brand's optional logo_url (0104), shown in Browse in
// place of the monogram. Global brands rows only; RLS (brands_all / is_allowed_user) gates the write.
export type BrandLogoRow = { prefix: string; name: string; country: string | null; description: string | null; logo_url: string | null };

export async function getBrandLogos(): Promise<BrandLogoRow[]> {
  const supabase = createSupabaseServerClient();
  // Degrades gracefully as later columns land: try the full shape, then drop description (0110), then
  // logo_url (0104), so the list still renders on an older schema.
  let res = await supabase.from('brands').select('prefix,name,country,description,logo_url').order('name');
  if (res.error) res = await supabase.from('brands').select('prefix,name,country,logo_url').order('name') as typeof res;
  if (res.error) res = await supabase.from('brands').select('prefix,name,country').order('name') as typeof res;
  return ((res.data ?? []) as Partial<BrandLogoRow>[]).map((b) => ({
    prefix: b.prefix as string, name: b.name || (b.prefix as string),
    country: b.country ?? null, description: b.description ?? null, logo_url: b.logo_url ?? null,
  }));
}

// PR — Brands are a managed Settings list (add / edit / delete). Prefix is the PK (immutable identity).
export async function addBrand(input: { prefix: string; name?: string | null; country?: string | null; description?: string | null; logo_url?: string | null }): Promise<{ row: BrandLogoRow | null; error: string | null }> {
  const prefix = input.prefix?.trim().toUpperCase();
  if (!prefix) return { row: null, error: 'A brand prefix is required.' };
  const supabase = createSupabaseServerClient();
  const dup = await supabase.from('brands').select('prefix').eq('prefix', prefix).maybeSingle();
  if (dup.data) return { row: null, error: `Brand "${prefix}" already exists.` };
  const payload = { prefix, name: input.name?.trim() || null, country: input.country?.trim() || null, description: input.description?.trim() || null, logo_url: input.logo_url?.trim() || null };
  let { error } = await supabase.from('brands').insert(payload);
  if (error) { // degrade until 0110: retry without description so the brand still gets created
    const { description: _drop, ...rest } = payload;
    ({ error } = await supabase.from('brands').insert(rest));
  }
  if (error) return { row: null, error: error.message };
  return { row: { prefix, name: payload.name || prefix, country: payload.country, description: payload.description, logo_url: payload.logo_url }, error: null };
}

export async function updateBrand(prefix: string, patch: Partial<Pick<BrandLogoRow, 'name' | 'country' | 'description' | 'logo_url'>>): Promise<{ error: string | null }> {
  const p = prefix?.trim();
  if (!p) return { error: 'A brand is required.' };
  if (patch.logo_url && !/^(https?:\/\/|\/)/i.test(patch.logo_url)) return { error: 'The logo must be an uploaded image or full URL.' };
  const upd: Record<string, string | null> = {};
  if (patch.name !== undefined) upd.name = patch.name?.trim() || null;
  if (patch.country !== undefined) upd.country = patch.country?.trim() || null;
  if (patch.description !== undefined) upd.description = patch.description?.trim() || null;
  if (patch.logo_url !== undefined) upd.logo_url = patch.logo_url?.trim() || null;
  if (!Object.keys(upd).length) return { error: null };
  const supabase = createSupabaseServerClient();
  let { error } = await supabase.from('brands').update(upd).eq('prefix', p);
  if (error && 'description' in upd) { // degrade until 0110: retry without description so name/country/logo still save
    const { description: _drop, ...rest } = upd;
    if (Object.keys(rest).length) ({ error } = await supabase.from('brands').update(rest).eq('prefix', p));
    else error = null;
  }
  if (error) return { error: error.message };
  return { error: null };
}

// Delete is blocked while any SKU still references the brand (catalogue.brand_prefix FK).
export async function deleteBrand(prefix: string): Promise<{ error: string | null }> {
  const p = prefix?.trim();
  if (!p) return { error: 'A brand is required.' };
  const supabase = createSupabaseServerClient();
  const { count } = await supabase.from('catalogue').select('item_code', { count: 'exact', head: true }).eq('brand_prefix', p);
  if ((count ?? 0) > 0) return { error: `"${p}" is used by ${count} SKU${count === 1 ? '' : 's'} — reassign them before deleting.` };
  const { error } = await supabase.from('brands').delete().eq('prefix', p);
  if (error) return { error: error.message };
  return { error: null };
}

export async function addSearchAlias(
  term: string,
  alias: string,
  bothWays: boolean
): Promise<{ rows: SearchAlias[]; error: string | null }> {
  const t = term.trim().toLowerCase();
  const a = alias.trim().toLowerCase();
  if (!t || !a) return { rows: [], error: 'Both a search term and an alias are required.' };
  if (t === a) return { rows: [], error: 'The term and its alias must be different.' };

  const wanted: SearchAlias[] = bothWays
    ? [{ term: t, alias: a }, { term: a, alias: t }]
    : [{ term: t, alias: a }];

  const supabase = createSupabaseServerClient();
  // ignoreDuplicates so re-adding an existing pair is a no-op rather than an error; select returns only
  // the rows that were newly inserted.
  const { data, error } = await supabase
    .from('search_aliases')
    .upsert(wanted, { onConflict: 'term,alias', ignoreDuplicates: true })
    .select('term,alias');
  if (error) return { rows: [], error: error.message };
  return { rows: (data ?? []) as SearchAlias[], error: null };
}

export async function deleteSearchAlias(term: string, alias: string): Promise<{ error: string | null }> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from('search_aliases').delete().eq('term', term).eq('alias', alias);
  return { error: error ? error.message : null };
}
