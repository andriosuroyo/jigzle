// Shared types for the SETTINGS module (PR25). Plain module (NO 'use server') so the actions file
// can export only async functions — a Next.js production-build requirement (the linux SWC on Vercel
// rejects a 'use server' module that exports anything but async functions, incl. interfaces).

// ── the three list-row shapes (NULL-only / global rows; user_id & created_at omitted — never
//    surfaced to the editor in this PR) ──
// PR84: every list row carries an optional `icon` — a short emoji ('🏦') or a public Storage URL for
// an uploaded image (settings-icons bucket). The UI renders an <img> for a URL, else the text/emoji.
export interface PaymentMethod {
  id: number;
  label: string;
  icon: string | null;
  is_active: boolean;
  sort_order: number;
}

export interface CourierService {
  id: number;
  courier: string;
  speed: string | null;
  label: string;
  icon: string | null;
  is_active: boolean;
  sort_order: number;
}

export interface BoxPreset {
  id: number;
  code: string;
  dim_p: number | null;
  dim_l: number | null;
  dim_t: number | null;
  icon: string | null;
  is_active: boolean;
  sort_order: number;
}

// PR28: the Inbound per-line label pick-list (same shape as PaymentMethod). Note: this REPLACES the
// old `InboundLabel` string-union in @jigzle/db/types (dropped — the stored label is now free text).
export interface InboundLabel {
  id: number;
  label: string;
  icon: string | null;
  is_active: boolean;
  sort_order: number;
}

// 0035: the reusable shipment-note pick-list (gift wrap, free gift, …). Offered as a dropdown in the
// Pending/Fulfill note editor alongside free text. Same shape as PaymentMethod (label is the note text).
export interface CommonNote {
  id: number;
  label: string;
  icon: string | null;
  is_active: boolean;
  sort_order: number;
}

// 0046: the Customer contact-channel pick-list (WhatsApp / Instagram / Shopee / …), each with a brand
// icon. Read by the Customer detail's Channels picker. Same shape as PaymentMethod (label = platform).
export interface ChannelOption {
  id: number;
  label: string;
  icon: string | null;
  is_active: boolean;
  sort_order: number;
}

// 0052: the warehouse staff pick-list (Inbound + Outbound). Same shape as PaymentMethod (label = name).
// The active staff is chosen in the Inbound/Outbound header and stamped onto each receipt/outbound row.
export interface StaffMember {
  id: number;
  label: string;
  icon: string | null;
  is_active: boolean;
  sort_order: number;
}

// 0055: local (domestic, supplier-side) couriers — Purchasing To-forwarder's suggestions. SEPARATE
// from CourierService (the mandatory OUTBOUND shipping couriers Fulfill uses).
export interface LocalCourier {
  id: number;
  label: string;
  icon: string | null;    // PR275: logo — emoji or uploaded-image URL
  flag: string | null;    // PR275: country flag emoji
  country: string | null; // PR275: derived from the flag
  prefix: string | null;  // PR275: editable shorthand
  is_active: boolean;
  sort_order: number;
}

// 0056: international shipment couriers (DHL, FedEx, MTE…) — the carrier of a forwarder shipment,
// set on Purchasing History's shipment detail.
export interface ShipmentCourier {
  id: number;
  label: string;
  icon: string | null;    // PR275: logo — emoji or uploaded-image URL
  flag: string | null;    // PR275: country flag emoji
  country: string | null; // PR275: derived from the flag
  prefix: string | null;  // PR275: editable shorthand
  is_active: boolean;
  sort_order: number;
}

// 0066 (PR191): export couriers for international/outbound shipments (Repack, DHL, FedEx…), picked in
// Fulfill when the ship-to is outside Indonesia. needs_address → the courier receives the parcel first
// at its own intermediary address (the addr_* fields); DHL/FedEx pick up locally and have none.
export interface ExportCourier {
  id: number;
  label: string;
  icon: string | null;
  is_active: boolean;
  needs_address: boolean;
  addr_recipient: string | null;
  addr_phone: string | null;
  addr_text: string | null;
  sort_order: number;
}

// 0068 (PR205): SP Declare (Surat Pernyataan) declaration users — a person's identity that fills the
// customs declaration (picked in Doc Generator → SP Declare). KTP/NPWP/phone/address vary per person.
export interface DeclarationUser {
  id: number;
  name: string;
  ktp: string | null;
  npwp: string | null;
  phone: string | null;
  address: string | null;
  sort_order: number;
}

// 0087 (PR343/PR344): a search alias — searching `term` also matches items containing `alias` (character
// / series / franchise names, e.g. "peanuts" → "snoopy"). Keyed by (term, alias); no id/sort — the editor
// is add/remove only. Consumed inside the search_skus RPC, curated in Settings → Catalog → Search aliases.
export interface SearchAlias {
  term: string;
  alias: string;
}

// 0059 (PR193): the Catalog classification pick-lists (Product / Sub / Piece type). Same label-only
// shape as ChannelOption; read by the Catalog item editor's type comboboxes (unioned with the
// catalogue's distinct values).
export interface CatalogClassOption {
  id: number;
  label: string;
  icon: string | null;
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
  channels: ChannelOption[];
  staff: StaffMember[];
  localCouriers: LocalCourier[];
  shipmentCouriers: ShipmentCourier[];
  catProductTypes: CatalogClassOption[];
  catSubTypes: CatalogClassOption[];
  catPieceTypes: CatalogClassOption[];
}

// discriminator threaded through the write actions (maps to a table server-side).
export type SettingsKind = 'payment' | 'courier' | 'box' | 'inbound_labels' | 'common_note' | 'channel' | 'staff' | 'local_courier' | 'ship_courier' | 'cat_product_type' | 'cat_sub_type' | 'cat_piece_type';

export type SettingRow = PaymentMethod | CourierService | BoxPreset | InboundLabel | CommonNote | ChannelOption | StaffMember | LocalCourier | ShipmentCourier | CatalogClassOption;

// permissive payload shapes for add/update — the actions whitelist columns per kind, so a stray key
// can never reach an identity/system column (id / user_id / sort_order / created_at).
export type SettingPayload = Record<string, string | number | boolean | null>;
export type SettingPatch = Record<string, string | number | boolean | null>;
