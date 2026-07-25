'use server';

// Server actions = the only DB access path for the ops sales screen. Every call uses
// the SSR supabase client (anon key + the signed-in user's session cookie), so RLS
// (is_allowed_user()) governs every read and write. The service-role key is NEVER used
// here. The middleware has already gated the route to the single allowed user; RLS is
// the second, authoritative gate.

import { createSupabaseServerClient } from '@jigzle/db/server';
import { customerIdLabel, normalizePhone, tierFor, toNextTier } from '@jigzle/lib';
import type { Customer, CustomerAddress } from '@jigzle/db/types';
import type {
  CustomerHit,
  LoyaltyReadout,
  NewCustomerInput,
  NewAddressInput,
  SkuHit,
  CreateOrderInput,
  SubmitResult,
  CreateCustomerResult,
} from './types';

type Supabase = ReturnType<typeof createSupabaseServerClient>;

// PostgREST `.or()` / `.ilike()` interpolate the raw string into a filter grammar where
// , ( ) * \ are operators. Strip them from operator-typed user input (defense-in-depth;
// the operator is trusted, but never build a filter from unsanitized text).
function sanitize(q: string): string {
  return q.replace(/[,()*\\]/g, ' ').trim();
}

// ── lifetime spend per customer = Σ orders.paid_idr over their non-cancelled orders. This is the SAME
// source the Customer directory uses (getCustomerDetail / the customer_lifetime view, 0037). PR192 —
// the previous version summed the `payments` table, which is EMPTY for legacy orders (where orders.paid_idr
// is the only paid record), so long-time customers (e.g. Ida #7000) read as Rp 0 → No tier here while the
// Customer nav correctly showed them Platinum. Summing orders.paid_idr fixes the tier/spend drift. ──
async function lifetimeSpend(supabase: Supabase, customerIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!customerIds.length) return out;

  const { data: ords, error: oErr } = await supabase
    .from('orders')
    .select('customer_id, paid_idr, status')
    .in('customer_id', customerIds);
  if (oErr) { console.error('lifetimeSpend(orders):', oErr.message); return out; }

  for (const o of (ords ?? []) as { customer_id: number | null; paid_idr: number | null; status: string | null }[]) {
    if (o.customer_id == null || o.status === 'Cancelled') continue;
    out.set(o.customer_id, (out.get(o.customer_id) ?? 0) + (o.paid_idr ?? 0));
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

  // PR192 — order by name and take a generous window. The old `.limit(20)` with NO order let PostgREST
  // return an arbitrary 20 of the matches (then sorted client-side), so a valid match like "Ida" #7000
  // could be dropped entirely — the Customer nav (which scans every customer) still found it. Ordering
  // first makes the cut alphabetical and deterministic, and 200 comfortably covers a typed query.
  const { data, error } = await supabase
    .from('customers')
    .select('customer_id,name,phone')
    .or(filters.join(','))
    .order('name', { ascending: true })
    .limit(200);
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
): Promise<CreateCustomerResult> {
  const supabase = createSupabaseServerClient();
  const phone = normalizePhone(input.phone);
  const phone_raw = input.phone?.trim() || null;
  const channel = input.channel?.trim() || null;
  // PR159 — contact channels ({ platform, handle }), same jsonb shape the Customer detail writes;
  // keep only rows carrying a platform (a handle without a platform is dropped).
  const channels = (input.channels ?? [])
    .map((ch) => ({ platform: (ch.platform || '').trim(), handle: (ch.handle || '').trim() }))
    .filter((ch) => ch.platform);
  // PR339 — apply the "(last4)" Customer ID code at creation when a phone is present (the Fix backfill
  // still handles a phone added later). Empty name → null (the form now requires a Customer ID).
  const name = input.name?.trim() ? customerIdLabel(input.name, phone) : null;

  // Dedup: an existing normalized phone resolves to that customer (same person, reused — never a dup).
  if (phone) {
    const { data: existing } = await supabase
      .from('customers')
      .select('*')
      .eq('phone', phone)
      .maybeSingle();
    if (existing) return { customer: existing as Customer, existed: true };
  }

  // PR339 — block a duplicate Customer ID (same composed name) and surface the existing record(s), so the
  // operator can pick it or go back and enter a different ID.
  if (name) {
    const { data: sameName } = await supabase.from('customers').select('*').ilike('name', name);
    const exact = (sameName ?? []).filter((c) => ((c as Customer).name ?? '').trim().toLowerCase() === name.toLowerCase());
    if (exact.length) return { conflict: exact as Customer[] };
  }

  const { data, error } = await supabase
    .from('customers')
    .insert({ name, phone, phone_raw, channel, channel_raw: channel, channels })
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
  const street = input.street?.trim() || null;
  const kelurahan = input.kelurahan?.trim() || null;
  const kecamatan = input.kecamatan?.trim() || null;
  const kota = input.kota?.trim() || null;
  const provinsi = input.provinsi?.trim() || null;
  const negara = input.negara?.trim() || null;
  const kode_pos = input.kode_pos?.trim() || null;
  // compose the display string from the structured fields (same rule as the customer-detail form),
  // never including name / phone / delivery note.
  const raw_address = [street, kelurahan, kecamatan, kota, provinsi, negara, kode_pos].filter(Boolean).join(', ') || null;
  const { data, error } = await supabase
    .from('customer_addresses')
    .insert({
      customer_id: customerId,
      recipient_name: input.recipient_name?.trim() || null,
      contact_phone: input.contact_phone?.trim() || null,
      street, kelurahan, kecamatan, kota, provinsi, negara, kode_pos,
      delivery_note: input.delivery_note?.trim() || null,
      raw_address,
      // preserve the operator's original paste as the immutable audit blob
      source_blob: input.source_blob?.trim() || null,
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
  // PR156: cap at 10 (the RPC returns up to 20; fewer cards = a lighter, faster result list) and
  // enrich with `pending` ("on order") from the snapshot for the Inventory-style stat icons.
  const hits = ((data ?? []) as Omit<SkuHit, 'pending'>[]).slice(0, 10).map((h) => ({ ...h, pending: 0 }));
  if (hits.length) {
    const { data: snap } = await supabase
      .from('stock_snapshot')
      .select('item_code,pending')
      .in('item_code', hits.map((h) => h.item_code));
    const p = new Map<string, number>();
    for (const r of (snap ?? []) as { item_code: string; pending: number | null }[]) p.set(r.item_code, r.pending ?? 0);
    for (const h of hits) h.pending = p.get(h.item_code) ?? 0;
  }
  return hits;
}

// ── Panel 4: save + route the order (SA-3) ── (types in ./types)
// It creates the order, then re-checks availability against the LIVE stock_check view (not the
// search-time snapshot) and decides where the order goes (PR144 supersedes D5 — Fulfill = ready AND paid):
//   • every coded line has Σqty ≤ available AND fully paid → cut all lines now (cut_order_lines) → Fulfill.
//   • any coded line short, or not fully paid              → cut nothing → the order waits in Pending.
// An address may be null here (SA-1 "confirm address later"); create_order (0033) permits it and
// Fulfill confirms the address before Outbound.
// PR404 — a CUSTOM line (no item_code: an item the catalogue doesn't carry yet) has no stock record at
// all, so it can't be "in the warehouse": it always keeps the new order in Pending, where the operator
// buys/handles it. This gate is scoped to the save path — the wider "an uncoded line carries no stock
// gate" rule for legacy lines (Pending's lineStatus, getPreorders) is unchanged.
export async function submitOrder(payload: CreateOrderInput): Promise<SubmitResult> {
  if (!payload.lines?.length) throw new Error('submitOrder: at least one line is required');
  const supabase = createSupabaseServerClient();

  const { data: sid, error } = await supabase.rpc('create_order', { payload });
  if (error) throw new Error(`submitOrder: ${error.message}`);
  const salesId = sid as string;

  // PR73: stamp the order's urgency (the create_order RPC predates the column → set it here). Best-effort:
  // a failed urgency write must never lose the just-created order.
  if (payload.urgency && ['low', 'mid', 'high'].includes(payload.urgency)) {
    await supabase.from('orders').update({ urgency: payload.urgency }).eq('sales_id', salesId);
  }

  // read back the lines the RPC created
  const { data: lineRows } = await supabase
    .from('order_lines')
    .select('line_id,item_code,item_code_raw,qty')
    .eq('sales_id', salesId)
    .eq('is_cancelled', false);
  const lines = (lineRows ?? []) as { line_id: string; item_code: string | null; item_code_raw: string | null; qty: number }[];
  if (!lines.length) return { sales_id: salesId, routed: 'pending' };

  // PR404 — carry the custom lines' typed names into item_code_raw. Migration 0123 teaches create_order
  // to write them itself; until it's applied this patch keeps a custom line's name from being lost (and
  // once it is applied, the rows already carry the name so nothing here fires). create_order numbers its
  // lines {sales_id}-{n} in payload order, which is what maps a saved row back to its input.
  const rawByLineId = new Map<string, string>();
  payload.lines.forEach((l, i) => {
    const raw = l.item_code_raw?.trim();
    if (!l.item_code && raw) rawByLineId.set(`${salesId}-${i + 1}`, raw);
  });
  if (rawByLineId.size) {
    await Promise.all(
      lines
        .filter((l) => !l.item_code && !l.item_code_raw && rawByLineId.has(l.line_id))
        .map((l) => supabase.from('order_lines').update({ item_code_raw: rawByLineId.get(l.line_id) }).eq('line_id', l.line_id))
    );
  }

  // live availability re-check: Σqty per item_code ≤ available. A custom line (no item_code) has no
  // stock record → it can never read as available, so the order stays in Pending (PR404).
  const needByCode = new Map<string, number>();
  for (const l of lines) if (l.item_code) needByCode.set(l.item_code, (needByCode.get(l.item_code) ?? 0) + l.qty);
  const codes = [...needByCode.keys()];
  const availByCode = new Map<string, number>();
  if (codes.length) {
    const { data: sc } = await supabase.from('stock_check').select('item_code,available').in('item_code', codes);
    for (const r of sc ?? []) availByCode.set(r.item_code as string, (r.available as number) ?? 0);
  }
  let allAvailable = lines.every((l) => !!l.item_code); // a custom line is never sendable at save (PR404)
  for (const [code, need] of needByCode) {
    if ((availByCode.get(code) ?? 0) < need) { allAvailable = false; break; }
  }

  // PR144 — payment gate on the Fulfill route: only a fully-paid order cuts at save. A green-but-unpaid
  // order waits in Pending's Ready list until payment settles (same gate as Pending's Send ready items).
  const orderTotal = payload.lines.reduce((s, l) => s + l.qty * l.unit_price_idr, 0);
  const fullyPaid = (payload.payment?.amount_idr ?? 0) >= orderTotal;

  if (allAvailable && fullyPaid) {
    const { error: cutErr } = await supabase.rpc('cut_order_lines', {
      p_sales_id: salesId,
      p_line_ids: lines.map((l) => l.line_id),
    });
    if (cutErr) throw new Error(`submitOrder cut: ${cutErr.message}`);
    return { sales_id: salesId, routed: 'fulfill' };
  }
  return { sales_id: salesId, routed: 'pending' };
}
