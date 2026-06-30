// Types for the Customer directory (PR92). Plain module (NO 'use server') so the actions file can
// export only async functions (the linux SWC build rejects non-async exports from a 'use server' module).

import type { Tier, NextTier } from '@jigzle/lib';
import type { CustomerAddress, CustomerChannel } from '@jigzle/db/types';

// one contact channel in the detail panel (platform + handle); re-exported from the db type
export type ChannelEntry = CustomerChannel;

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
  channels: ChannelEntry[];     // 0045 — up to three { platform, handle } contact channels
  joined_date: string | null;   // first purchase (min orders.order_date)
  last_purchase: string | null; // last purchase (max orders.order_date)
  order_count: number;
  lifetime_spend: number;       // Σ payments.amount_idr across the customer's orders
  tier: Tier | null;
  to_next_tier: NextTier | null;
  addresses: CustomerAddress[];
}

// ── data health (PR107): read-only customer-integrity scan ──
// A set of customers joined by a shared phone number (the import's phone-split signature).
export interface DataHealthGroup {
  memberIds: number[];
  members: { id: number; name: string | null; phones: string[] }[];
  sharedPhones: string[];   // the number(s) that tie the group together (search seed for the merge tool)
  numberCount: number;      // distinct numbers across the group — > 3 means a merge needs a manual choice
}

export interface DataHealth {
  totalCustomers: number;
  noName: number;                 // customers with a blank name
  sharedPhoneGroupCount: number;  // groups of customers sharing a number
  overThreeCount: number;         // of those, how many would overflow the 3 phone slots on merge
  groups: DataHealthGroup[];      // capped list, most-numbers first
}

// editable personal details (name + up to three whatsapp/phone numbers)
export interface CustomerPatch {
  name?: string | null;
  phone?: string | null;  // raw input; stored normalized + raw. phone = primary (dedup/search key)
  phone2?: string | null;
  phone3?: string | null;
  channels?: ChannelEntry[]; // 0045 — replaces the whole channels array when present
}

// ── duplicate-merge (customer cleanup, PR102) ──
// One customer inside a possible-duplicate group, with the signals that tell a real record
// (orders / last purchase) apart from a stray contact fragment (no orders).
export interface DuplicateMember {
  id: number;
  name: string | null;
  phones: string[];          // up to three contact numbers (raw, display form), already de-duplicated
  order_count: number;
  last_purchase: string | null;
  lifetime_spend: number;
  address_count: number;
}

// A set of customers that share a normalized name and look like the same person split across rows
// (at least one member carries no orders — a likely stray fragment).
export interface DuplicateGroup {
  key: string;               // normalized name (grouping key)
  name: string;              // display name (first non-blank member name)
  members: DuplicateMember[];
}

// Outcome of merging strays into a primary record — a short receipt for the UI notice.
export interface MergeResult {
  primaryId: number;
  removedIds: number[];      // the stray records that were deleted
  phonesAdded: number;       // distinct numbers ported into the primary's free slots
  droppedPhones: number;     // numbers that didn't fit (primary already had three)
  channelsAdded: number;     // distinct channels (platform+handle) ported into the primary
  addressesMoved: number;
  addressesSkipped: number;  // dropped as duplicates of an address the primary already had
  recordsReassigned: number; // orders / shipments / etc. re-pointed at the primary
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
