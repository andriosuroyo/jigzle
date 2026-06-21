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
  SubmitResult,
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
  const hits = data.map((c) => {
    const lifetime = spend.get(c.customer_id as number) ?? 0;
    return {
      id: c.customer_id as number,
      name: c.name as string | null,
      phone: c.phone as string | null,
      tier: tierFor(lifetime).tier,
      lifetime_spend: lifetime,
    };
  });
  // A–Z by lower(name), nulls/blank last — alphabetical is what helps scan a long list (PR24 §1).
  return hits.sort((a, b) => {
    const an = a.name?.trim().toLowerCase() ?? '';
    const bn = b.name?.trim().toLowerCase() ?? '';
    if (an === bn) return 0;
    if (!an) return 1;
    if (!bn) return -1;
    return an.localeCompare(bn);
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

// ── Panel 2: SKU search — ONE round-trip via the shared search_skus RPC (PR23 §2b / migration 0027),
// the SAME function Stock Check's Add field calls (one source of truth, no drift). Word-split: every
// whitespace token (≥3 chars) must match item_code OR translate_name (so "Snoopy 1000" works); exact
// item_code ranks first; cap 20; available + on_the_way from the stock_snapshot matview (0 when absent
// → 0-stock preorder SKUs still appear). SECURITY INVOKER → the same RLS (is_allowed_user) that gated
// the old direct selects applies. 3-char floor so the 0025 pg_trgm GIN index is eligible.
export async function searchSkus(q: string): Promise<SkuHit[]> {
  const raw = sanitize(q);
  if (raw.length < 3) return []; // <3 chars can't use the pg_trgm index → don't bother the DB
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('search_skus', { p_q: raw });
  if (error) return []; // search failures are non-fatal (same posture as before)
  return (data ?? []) as SkuHit[];
}

// ── Panel 4: save + route the order (SA-3) ── (types in ./types)
// New does not gate on payment (D5). It creates the order, then re-checks availability against the
// LIVE stock_check view (not the search-time snapshot) and decides where the order goes:
//   • every coded line has Σqty ≤ available  → cut all lines now (cut_order_lines) → To-send (Fulfill).
//   • any coded line short                    → cut nothing → the order waits in Pending.
// An address may be null here (SA-1 "confirm address later"); create_order (0033) permits it and
// Fulfill confirms the address before Outbound. Lines with no item_code carry no stock gate (the
// per-code constraint simply doesn't include them) and never block the Fulfill route.
export async function submitOrder(payload: CreateOrderInput): Promise<SubmitResult> {
  if (!payload.lines?.length) throw new Error('submitOrder: at least one line is required');
  const supabase = createSupabaseServerClient();

  const { data: sid, error } = await supabase.rpc('create_order', { payload });
  if (error) throw new Error(`submitOrder: ${error.message}`);
  const salesId = sid as string;

  // read back the lines the RPC created
  const { data: lineRows } = await supabase
    .from('order_lines')
    .select('line_id,item_code,qty')
    .eq('sales_id', salesId)
    .eq('is_cancelled', false);
  const lines = (lineRows ?? []) as { line_id: string; item_code: string | null; qty: number }[];
  if (!lines.length) return { sales_id: salesId, routed: 'pending' };

  // live availability re-check: Σqty per item_code ≤ available (uncoded lines carry no gate)
  const needByCode = new Map<string, number>();
  for (const l of lines) if (l.item_code) needByCode.set(l.item_code, (needByCode.get(l.item_code) ?? 0) + l.qty);
  const codes = [...needByCode.keys()];
  const availByCode = new Map<string, number>();
  if (codes.length) {
    const { data: sc } = await supabase.from('stock_check').select('item_code,available').in('item_code', codes);
    for (const r of sc ?? []) availByCode.set(r.item_code as string, (r.available as number) ?? 0);
  }
  let allAvailable = true;
  for (const [code, need] of needByCode) {
    if ((availByCode.get(code) ?? 0) < need) { allAvailable = false; break; }
  }

  if (allAvailable) {
    const { error: cutErr } = await supabase.rpc('cut_order_lines', {
      p_sales_id: salesId,
      p_line_ids: lines.map((l) => l.line_id),
    });
    if (cutErr) throw new Error(`submitOrder cut: ${cutErr.message}`);
    return { sales_id: salesId, routed: 'fulfill' };
  }
  return { sales_id: salesId, routed: 'pending' };
}

// ── kept for back-compat until OrderEntry switches fully to submitOrder (Stage 3) ──
export async function createOrder(payload: CreateOrderInput): Promise<{ sales_id: string }> {
  if (!payload.lines?.length) throw new Error('createOrder: at least one line is required');
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('create_order', { payload });
  if (error) throw new Error(`createOrder: ${error.message}`);
  return { sales_id: data as string };
}
