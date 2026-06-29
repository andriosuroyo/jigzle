// Types for the Customer directory (PR92). Plain module (NO 'use server') so the actions file can
// export only async functions (the linux SWC build rejects non-async exports from a 'use server' module).

import type { Tier, NextTier } from '@jigzle/lib';
import type { CustomerAddress } from '@jigzle/db/types';

// one row in the A–Z directory list (lightweight — tier/spend are loaded per customer in the detail)
export interface CustomerListRow {
  id: number;
  name: string | null;
  phone: string | null;
}

// the full detail panel for one customer
export interface CustomerDetail {
  id: number;
  name: string | null;
  phone: string | null;
  phone_raw: string | null;
  phone2_raw: string | null;
  phone3_raw: string | null;
  channel: string | null;
  ig_handle: string | null;
  joined_date: string | null;   // first purchase (min orders.order_date)
  last_purchase: string | null; // last purchase (max orders.order_date)
  order_count: number;
  lifetime_spend: number;       // Σ payments.amount_idr across the customer's orders
  tier: Tier | null;
  to_next_tier: NextTier | null;
  addresses: CustomerAddress[];
}

// editable personal details (name + up to three whatsapp/phone numbers)
export interface CustomerPatch {
  name?: string | null;
  phone?: string | null;  // raw input; stored normalized + raw. phone = primary (dedup/search key)
  phone2?: string | null;
  phone3?: string | null;
}

// editable address fields (add / edit) — structured, big-to-small. The free-text `street` holds only
// street / alley (gang); country/province/city/subdistrict/ward/postcode are their own fields. A
// readable raw_address is composed from them server-side for the legacy display consumers.
export interface AddressInput {
  recipient_name?: string | null;
  contact_phone?: string | null;
  negara?: string | null;     // country
  provinsi?: string | null;   // province
  kota?: string | null;       // city / district
  kecamatan?: string | null;  // subdistrict (Indonesia)
  kelurahan?: string | null;  // ward (Indonesia)
  kode_pos?: string | null;   // postcode
  street?: string | null;     // street / alley — the "address" main field
}
