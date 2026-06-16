'use server';

// Server actions = the only DB access path for the ops sales screen. Every call uses
// the SSR supabase client (anon key + the signed-in user's session cookie), so RLS
// (is_allowed_user()) governs every read and write. The service-role key is NEVER used
// here. The middleware has already gated the route to the single allowed user; RLS is
// the second, authoritative gate.

import { createSupabaseServerClient } from '@jigzle/db/server';
import { normalizePhone, tierFor, toNextTier } from '@jigzle/lib';
import type { Customer, CustomerAddress } from '@jigzle/db/types';
import type {
  CustomerHit,
  LoyaltyReadout,
  NewCustomerInput,
  NewAddressInput,
  SkuHit,
  CreateOrderInput,
} from './types';

type Supabase = ReturnType<typeof createSupabaseServerClient>;

// PostgREST `.or()` / `.ilike()` interpolate the raw string into a filter grammar where
// , ( ) * \ are operators. Strip them from operator-typed user input (defense-in-depth;
// the operator is trusted, but never build a filter from unsanitized text).
function sanitize(q: string): string {
  return q.replace(/[,()*\\]/g, ' ').trim();
}

// ── lifetime spend (Σ payments.amount_idr) per customer, via the payments→orders FK ──
async function lifetimeSpend(supabase: Supabase, customerIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!customerIds.length) return out;
  const { data, error } = await supabase
    .from('payments')
    .select('amount_idr, orders!inner(customer_id)')
    .in('orders.customer_id', customerIds);
  if (error || !data) return out;
  for (const row of data as unknown as { amount_idr: number; orders: { customer_id: number } | null }[]) {
    const cid = row.orders?.customer_id;
    if (cid == null) continue;
    out.set(cid, (out.get(cid) ?? 0) + (row.amount_idr ?? 0));
  }
  return out;
}

// ── Panel 1: customer search (normalized phone + name, case-insensitive contains) ── (types in ./types)
export async function searchCustomers(q: string): Promise<CustomerHit[]> {
  const raw = sanitize(q);
  if (raw.length < 2) return [];
  const supabase = createSupabaseServerClient();

  const norm = normalizePhone(raw);
  const digits = raw.replace(/\D/g, '');
  const filters = [`name.ilike.%${raw}%`, `phone_raw.ilike.%${raw}%`];
  if (norm) filters.push(`phone.ilike.%${norm}%`);
  else if (digits.length >= 3) filters.push(`phone.ilike.%${digits}%`);

  const { data, error } = await supabase
    .from('customers')
    .select('customer_id,name,phone')
    .or(filters.join(','))
    .limit(20);
  if (error || !data?.length) return [];

  const ids = data.map((c) => c.customer_id as number);
  const spend = await lifetimeSpend(supabase, ids);
  return data.map((c) => {
    const lifetime = spend.get(c.customer_id as number) ?? 0;
    return {
      id: c.customer_id as number,
      name: c.name as string | null,
      phone: c.phone as string | null,
      tier: tierFor(lifetime).tier,
      lifetime_spend: lifetime,
    };
  });
}

// ── Panel 1: loyalty readout for the selected customer ──
export async function getLoyalty(customerId: number): Promise<LoyaltyReadout> {
  const supabase = createSupabaseServerClient();
  const spend = await lifetimeSpend(supabase, [customerId]);
  const lifetime = spend.get(customerId) ?? 0;
  return { tier: tierFor(lifetime).tier, lifetime_spend: lifetime, to_next_tier: toNextTier(lifetime) };
}

// ── Panel 1: create-or-return customer (dedup on the normalized-phone unique index) ──
export async function createCustomer(
  input: NewCustomerInput
): Promise<{ customer: Customer; existed: boolean }> {
  const supabase = createSupabaseServerClient();
  const phone = normalizePhone(input.phone);
  const phone_raw = input.phone?.trim() || null;
  const channel = input.channel?.trim() || null;

  // Dedup: an existing normalized phone resolves to that customer (never a duplicate).
  if (phone) {
    const { data: existing } = await supabase
      .from('customers')
      .select('*')
      .eq('phone', phone)
      .maybeSingle();
    if (existing) return { customer: existing as Customer, existed: true };
  }

  const { data, error } = await supabase
    .from('customers')
    .insert({ name: input.name?.trim() || null, phone, phone_raw, channel, channel_raw: channel })
    .select('*')
    .single();

  if (error) {
    // Race on the partial unique index → fetch the winner instead of duplicating.
    if (error.code === '23505' && phone) {
      const { data: existing } = await supabase
        .from('customers')
        .select('*')
        .eq('phone', phone)
        .maybeSingle();
      if (existing) return { customer: existing as Customer, existed: true };
    }
    throw new Error(`createCustomer: ${error.message}`);
  }
  return { customer: data as Customer, existed: false };
}

// ── Panel 3: the customer's saved addresses ──
export async function getCustomerAddresses(customerId: number): Promise<CustomerAddress[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('customer_addresses')
    .select('*')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false });
  if (error || !data) return [];
  return data as CustomerAddress[];
}

export async function createAddress(
  customerId: number,
  input: NewAddressInput
): Promise<CustomerAddress> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('customer_addresses')
    .insert({
      customer_id: customerId,
      recipient_name: input.recipient_name?.trim() || null,
      contact_phone: input.contact_phone?.trim() || null,
      raw_address: input.raw_address?.trim() || null,
      kota: input.kota?.trim() || null,
      kode_pos: input.kode_pos?.trim() || null,
    })
    .select('*')
    .single();
  if (error) throw new Error(`createAddress: ${error.message}`);
  return data as CustomerAddress;
}

// ── Panel 2: SKU search (catalogue text + barcode), with live stock_check.available ──
export async function searchSkus(q: string): Promise<SkuHit[]> {
  const raw = sanitize(q);
  if (raw.length < 2) return [];
  const supabase = createSupabaseServerClient();

  const named = new Map<string, string>(); // item_code → display name
  const nameOf = (c: {
    item_code: string;
    translate_name: string | null;
    original_name: string | null;
    self_code: string | null;
  }) => c.translate_name || c.original_name || c.self_code || c.item_code;

  const [catRes, bcRes] = await Promise.all([
    supabase
      .from('catalogue')
      .select('item_code,original_name,translate_name,self_code')
      .or(
        `item_code.ilike.%${raw}%,self_code.ilike.%${raw}%,original_name.ilike.%${raw}%,translate_name.ilike.%${raw}%`
      )
      .limit(15),
    supabase.from('barcodes').select('item_code').ilike('barcode', `%${raw}%`).limit(15),
  ]);

  for (const c of catRes.data ?? []) named.set(c.item_code as string, nameOf(c as never));

  // Barcode-only hits: resolve their catalogue names too.
  const bcCodes = [...new Set((bcRes.data ?? []).map((b) => b.item_code as string))].filter(
    (code) => !named.has(code)
  );
  if (bcCodes.length) {
    const { data: cat2 } = await supabase
      .from('catalogue')
      .select('item_code,original_name,translate_name,self_code')
      .in('item_code', bcCodes);
    for (const c of cat2 ?? []) named.set(c.item_code as string, nameOf(c as never));
  }

  const codes = [...named.keys()].slice(0, 20);
  if (!codes.length) return [];

  const { data: stock } = await supabase
    .from('stock_check')
    .select('item_code,available')
    .in('item_code', codes);
  const avail = new Map((stock ?? []).map((s) => [s.item_code as string, s.available as number]));

  return codes.map((item_code) => ({
    item_code,
    name: named.get(item_code)!,
    available: avail.get(item_code) ?? 0,
  }));
}

// ── Panel 5: save the order (atomic, via the create_order RPC) ── (types in ./types)
export async function createOrder(payload: CreateOrderInput): Promise<{ sales_id: string }> {
  if (!payload.lines?.length) throw new Error('createOrder: at least one line is required');
  if (!payload.address_id) throw new Error('createOrder: an address is required');
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('create_order', { payload });
  if (error) throw new Error(`createOrder: ${error.message}`);
  return { sales_id: data as string };
}
