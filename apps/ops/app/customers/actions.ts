'use server';

// Server actions for the Customer directory (PR92). Same auth posture as the rest of the app: the SSR
// supabase client (anon key + the signed-in user's session), so RLS (is_allowed_user()) gates reads
// and writes. Reads draw from customers / orders / payments / customer_addresses (no new tables).

import { createSupabaseServerClient } from '@jigzle/db/server';
import { normalizePhone, tierFor, toNextTier, type Tier } from '@jigzle/lib';
import type { Customer, CustomerAddress, CustomerChannel } from '@jigzle/db/types';
import type { AddressInput, CustomerDetail, CustomerListRow, CustomerPatch } from './types';

// ── the A–Z directory: every customer, lightweight (id / name / phone), name-sorted ──
// PostgREST caps a single response at ~1000 rows regardless of .limit(), so we PAGE through with
// .range() until a short page comes back. Order by (name, customer_id) for a stable paging key — same
// name across a page boundary must not duplicate or skip a row.
export async function getCustomers(): Promise<CustomerListRow[]> {
  const supabase = createSupabaseServerClient();
  const PAGE = 1000;
  const out: CustomerListRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('customers')
      .select('customer_id,name,phone')
      .order('name', { ascending: true })
      .order('customer_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const c of data as { customer_id: number; name: string | null; phone: string | null }[]) {
      out.push({ id: c.customer_id, name: c.name, phone: c.phone });
    }
    if (data.length < PAGE) break;
  }
  return out;
}

// ── member tier per customer (for the directory quickview), from the customer_lifetime view (0037).
// One paged read of {customer_id, lifetime_paid_idr} → only Bronze+ customers are returned to keep the
// map small. Degrades to {} if the view isn't present, so the list just shows no tiers. ──
export async function getCustomerTiers(): Promise<Record<number, Tier>> {
  const supabase = createSupabaseServerClient();
  const out: Record<number, Tier> = {};
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('customer_lifetime')
      .select('customer_id,lifetime_paid_idr')
      .order('customer_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const r of data as { customer_id: number; lifetime_paid_idr: number | null }[]) {
      const tier = tierFor(Number(r.lifetime_paid_idr) || 0).tier;
      if (tier) out[r.customer_id] = tier;
    }
    if (data.length < PAGE) break;
  }
  return out;
}

// ── full detail for one customer: contact + first/last purchase + lifetime spend/tier + addresses ──
export async function getCustomerDetail(customerId: number): Promise<CustomerDetail | null> {
  const supabase = createSupabaseServerClient();
  const { data: c } = await supabase.from('customers').select('*').eq('customer_id', customerId).maybeSingle();
  if (!c) return null;
  const cust = c as Customer & { ig_handle: string | null };
  // channels (0045): jsonb array of { platform, handle }; tolerate legacy null / malformed rows
  const channels = (Array.isArray(cust.channels) ? cust.channels : [])
    .filter((ch): ch is CustomerChannel => !!ch && typeof ch === 'object')
    .map((ch) => ({ platform: String(ch.platform ?? ''), handle: String(ch.handle ?? '') }));

  // the customer's orders → joined (first) + last purchase date + lifetime spend. Spend is Σ orders.paid_idr
  // over non-cancelled orders — the SAME source as the customer_lifetime view (0037) that drives the
  // list tier. (The payments table is empty for legacy orders, where paid_idr is the only paid record,
  // so summing payments here used to show Rp 0 for long-time customers like Aarde — quickview/detail drift.)
  const { data: ords } = await supabase
    .from('orders')
    .select('order_date,paid_idr,status')
    .eq('customer_id', customerId);
  const orders = (ords ?? []) as { order_date: string | null; paid_idr: number | null; status: string | null }[];
  const active = orders.filter((o) => o.status !== 'Cancelled');
  const dates = active.map((o) => o.order_date).filter((d): d is string => !!d).sort();
  const joined = dates[0] ?? null;
  const last = dates.length ? dates[dates.length - 1] : null;
  const lifetime = active.reduce((sum, o) => sum + (o.paid_idr ?? 0), 0);

  const { data: addrs } = await supabase
    .from('customer_addresses')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false });

  return {
    id: cust.customer_id,
    name: cust.name,
    phone: cust.phone,
    phone_raw: cust.phone_raw,
    phone2_raw: cust.phone2_raw,
    phone3_raw: cust.phone3_raw,
    channel: cust.channel,
    ig_handle: cust.ig_handle ?? null,
    channels,
    joined_date: joined,
    last_purchase: last,
    order_count: active.length,
    lifetime_spend: lifetime,
    tier: tierFor(lifetime).tier,
    to_next_tier: toNextTier(lifetime),
    addresses: (addrs ?? []) as CustomerAddress[],
  };
}

// ── edit personal details (name + whatsapp/phone). Phone is stored normalized + raw. ──
export async function updateCustomer(customerId: number, patch: CustomerPatch): Promise<void> {
  const supabase = createSupabaseServerClient();
  const upd: Record<string, unknown> = {};
  if (patch.name !== undefined) upd.name = patch.name?.trim() || null;
  if (patch.phone !== undefined) {
    const raw = patch.phone?.trim() || null;
    upd.phone_raw = raw;
    upd.phone = raw ? normalizePhone(raw) : null;
  }
  if (patch.phone2 !== undefined) {
    const raw = patch.phone2?.trim() || null;
    upd.phone2_raw = raw;
    upd.phone2 = raw ? normalizePhone(raw) : null;
  }
  if (patch.phone3 !== undefined) {
    const raw = patch.phone3?.trim() || null;
    upd.phone3_raw = raw;
    upd.phone3 = raw ? normalizePhone(raw) : null;
  }
  if (patch.channels !== undefined) {
    // keep only rows that carry a platform; trim handles. Stored as the whole jsonb array.
    upd.channels = patch.channels
      .map((ch) => ({ platform: (ch.platform || '').trim(), handle: (ch.handle || '').trim() }))
      .filter((ch) => ch.platform);
  }
  if (Object.keys(upd).length === 0) return;
  const { error } = await supabase.from('customers').update(upd).eq('customer_id', customerId);
  if (error) {
    if (error.code === '23505') throw new Error('That phone number is already on another customer.');
    throw new Error(`updateCustomer: ${error.message}`);
  }
}

// ── addresses: add / edit / delete (overlay) ──
function addrFields(input: AddressInput): Record<string, unknown> {
  const street = input.street?.trim() || null;
  const kelurahan = input.kelurahan?.trim() || null;
  const kecamatan = input.kecamatan?.trim() || null;
  const kota = input.kota?.trim() || null;
  const provinsi = input.provinsi?.trim() || null;
  const negara = input.negara?.trim() || null;
  const kode_pos = input.kode_pos?.trim() || null;
  // compose a readable full address for the legacy display consumers (addressLine / Fulfill)
  const raw_address = [street, kelurahan, kecamatan, kota, provinsi, negara, kode_pos].filter(Boolean).join(', ') || null;
  return {
    recipient_name: input.recipient_name?.trim() || null,
    contact_phone: input.contact_phone?.trim() || null,
    street, kelurahan, kecamatan, kota, provinsi, negara, kode_pos, raw_address,
  };
}

export async function addCustomerAddress(customerId: number, input: AddressInput): Promise<CustomerAddress> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('customer_addresses')
    .insert({ customer_id: customerId, ...addrFields(input) })
    .select('*')
    .single();
  if (error) throw new Error(`addCustomerAddress: ${error.message}`);
  return data as CustomerAddress;
}

export async function updateCustomerAddress(addressId: number, input: AddressInput): Promise<CustomerAddress> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('customer_addresses')
    .update(addrFields(input))
    .eq('address_id', addressId)
    .select('*')
    .single();
  if (error) throw new Error(`updateCustomerAddress: ${error.message}`);
  return data as CustomerAddress;
}

export async function deleteCustomerAddress(addressId: number): Promise<void> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from('customer_addresses').delete().eq('address_id', addressId);
  if (error) throw new Error(`deleteCustomerAddress: ${error.message}`);
}
