'use server';

// Server actions for the Customer directory (PR92). Same auth posture as the rest of the app: the SSR
// supabase client (anon key + the signed-in user's session), so RLS (is_allowed_user()) gates reads
// and writes. Reads draw from customers / orders / payments / customer_addresses (no new tables).

import { createSupabaseServerClient } from '@jigzle/db/server';
import { normalizePhone, tierFor, toNextTier } from '@jigzle/lib';
import type { Customer, CustomerAddress } from '@jigzle/db/types';
import type { AddressInput, CustomerDetail, CustomerListRow, CustomerPatch } from './types';

// ── the A–Z directory: every customer, lightweight (id / name / phone), name-sorted ──
export async function getCustomers(): Promise<CustomerListRow[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('customers')
    .select('customer_id,name,phone')
    .order('name', { ascending: true })
    .limit(20000);
  if (error || !data) return [];
  return (data as { customer_id: number; name: string | null; phone: string | null }[]).map((c) => ({
    id: c.customer_id,
    name: c.name,
    phone: c.phone,
  }));
}

// ── full detail for one customer: contact + first/last purchase + lifetime spend/tier + addresses ──
export async function getCustomerDetail(customerId: number): Promise<CustomerDetail | null> {
  const supabase = createSupabaseServerClient();
  const { data: c } = await supabase.from('customers').select('*').eq('customer_id', customerId).maybeSingle();
  if (!c) return null;
  const cust = c as Customer & { ig_handle: string | null };

  // the customer's orders → joined (first) + last purchase date, and the sales_ids to sum payments over
  const { data: ords } = await supabase.from('orders').select('sales_id,order_date').eq('customer_id', customerId);
  const orders = (ords ?? []) as { sales_id: string; order_date: string | null }[];
  const dates = orders.map((o) => o.order_date).filter((d): d is string => !!d).sort();
  const joined = dates[0] ?? null;
  const last = dates.length ? dates[dates.length - 1] : null;

  // lifetime spend = Σ payments.amount_idr over the customer's sales_ids (chunked to stay under URL limits)
  let lifetime = 0;
  const salesIds = orders.map((o) => o.sales_id);
  const CHUNK = 300;
  for (let i = 0; i < salesIds.length; i += CHUNK) {
    const { data: pays } = await supabase.from('payments').select('amount_idr').in('sales_id', salesIds.slice(i, i + CHUNK));
    for (const p of (pays ?? []) as { amount_idr: number | null }[]) lifetime += p.amount_idr ?? 0;
  }

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
    channel: cust.channel,
    ig_handle: cust.ig_handle ?? null,
    joined_date: joined,
    last_purchase: last,
    order_count: orders.length,
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
  if (Object.keys(upd).length === 0) return;
  const { error } = await supabase.from('customers').update(upd).eq('customer_id', customerId);
  if (error) {
    if (error.code === '23505') throw new Error('That phone number is already on another customer.');
    throw new Error(`updateCustomer: ${error.message}`);
  }
}

// ── addresses: add / edit / delete (overlay) ──
function addrFields(input: AddressInput): Record<string, unknown> {
  return {
    recipient_name: input.recipient_name?.trim() || null,
    contact_phone: input.contact_phone?.trim() || null,
    raw_address: input.raw_address?.trim() || null,
    kota: input.kota?.trim() || null,
    kode_pos: input.kode_pos?.trim() || null,
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
