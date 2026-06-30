'use server';

// Server actions for the Customer directory (PR92). Same auth posture as the rest of the app: the SSR
// supabase client (anon key + the signed-in user's session), so RLS (is_allowed_user()) gates reads
// and writes. Reads draw from customers / orders / payments / customer_addresses (no new tables).

import { createSupabaseServerClient } from '@jigzle/db/server';
import { normalizePhone, phoneCode, tierFor, toNextTier, type Tier } from '@jigzle/lib';
import type { Customer, CustomerAddress, CustomerChannel } from '@jigzle/db/types';
import type {
  AddressDupGroup,
  AddressInput,
  CustomerDetail,
  CustomerListRow,
  CustomerPatch,
  DataHealth,
  DataHealthGroup,
  DuplicateGroup,
  DuplicateMember,
  EmptyStray,
  MergeResult,
} from './types';

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

// ── duplicate cleanup (PR102): find likely-duplicate customers and merge strays into the real record ──
//
// The same person sometimes lands in several rows — a real account with the orders, plus one or more
// stray fragments that only hold a phone or an address (Henny Y had four). We surface name-collision
// groups that contain at least one order-less fragment (the "split up" signal) and let the operator
// pick the keeper and pull the strays' contacts in.

// normalized name key — lowercased, trimmed, internal whitespace collapsed (so "Henny  Y" == "henny y")
function nameKey(name: string | null): string {
  return (name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// stable key for an address so a stray's address isn't re-added when the primary already has it
function addressKey(a: { raw_address: string | null; street: string | null; kelurahan: string | null; kecamatan: string | null; kota: string | null; provinsi: string | null; negara: string | null; kode_pos: string | null }): string {
  const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/[\s,]+/g, ' ').trim();
  const raw = norm(a.raw_address);
  if (raw) return raw;
  return [a.street, a.kelurahan, a.kecamatan, a.kota, a.provinsi, a.negara, a.kode_pos].map(norm).join('|');
}

async function chunked<T>(ids: number[], size: number, run: (slice: number[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await run(ids.slice(i, i + size))));
  return out;
}

type ServerDB = ReturnType<typeof createSupabaseServerClient>;
type CustPhoneRow = { customer_id: number; name: string | null; phone_raw: string | null; phone: string | null; phone2_raw: string | null; phone2: string | null; phone3_raw: string | null; phone3: string | null };
const PHONE_COLS = 'customer_id,name,phone_raw,phone,phone2_raw,phone2,phone3_raw,phone3';

// strip the characters that would break a PostgREST .or() filter (mirrors purchasing/sanitize)
function sanitizeSearch(q: string): string {
  return q.replace(/[,()*\\]/g, ' ').trim();
}

// a name already carries a "(1234)" style code at the end
const HAS_CODE = /\(\d{2,5}\)\s*$/;
// a named customer with a primary number but no trailing code → eligible for the (last4) backfill
function needsNameCode(name: string | null, phone: string | null): boolean {
  return !!phoneCode(phone) && !!(name ?? '').trim() && !HAS_CODE.test(name ?? '');
}

// Annotate a set of customer rows with the signals the merge UI shows — order count, last purchase,
// lifetime spend, address count. Shared by the database scan and the by-ID search.
async function annotateMembers(supabase: ServerDB, rows: CustPhoneRow[]): Promise<DuplicateMember[]> {
  const ids = rows.map((r) => r.customer_id);
  if (!ids.length) return [];
  const ords = await chunked(ids, 200, async (slice) => {
    const { data } = await supabase.from('orders').select('customer_id,order_date,paid_idr,status').in('customer_id', slice);
    return (data ?? []) as { customer_id: number; order_date: string | null; paid_idr: number | null; status: string | null }[];
  });
  const orderStat = new Map<number, { count: number; last: string | null; spend: number }>();
  for (const o of ords) {
    if (o.status === 'Cancelled') continue;
    const s = orderStat.get(o.customer_id) ?? { count: 0, last: null, spend: 0 };
    s.count += 1;
    s.spend += o.paid_idr ?? 0;
    if (o.order_date && (!s.last || o.order_date > s.last)) s.last = o.order_date;
    orderStat.set(o.customer_id, s);
  }
  const addrs = await chunked(ids, 200, async (slice) => {
    const { data } = await supabase.from('customer_addresses').select('customer_id').in('customer_id', slice);
    return (data ?? []) as { customer_id: number }[];
  });
  const addrCount = new Map<number, number>();
  for (const a of addrs) addrCount.set(a.customer_id, (addrCount.get(a.customer_id) ?? 0) + 1);
  return rows.map((r) => {
    const st = orderStat.get(r.customer_id);
    const phones = [r.phone_raw ?? r.phone, r.phone2_raw ?? r.phone2, r.phone3_raw ?? r.phone3].filter((p): p is string => !!p);
    return {
      id: r.customer_id,
      name: r.name,
      phones,
      order_count: st?.count ?? 0,
      last_purchase: st?.last ?? null,
      lifetime_spend: st?.spend ?? 0,
      address_count: addrCount.get(r.customer_id) ?? 0,
    };
  });
}

// All same-name groups that contain a likely stray (≥2 members, at least one with no orders), each
// member annotated with the order / spend / address signals the UI uses to tell keeper from fragment.
export async function getDuplicateGroups(): Promise<DuplicateGroup[]> {
  const supabase = createSupabaseServerClient();

  // 1) page the whole directory (id / name / phones) and group by normalized name
  type Row = { customer_id: number; name: string | null; phone_raw: string | null; phone: string | null; phone2_raw: string | null; phone2: string | null; phone3_raw: string | null; phone3: string | null };
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('customers')
      .select('customer_id,name,phone_raw,phone,phone2_raw,phone2,phone3_raw,phone3')
      .order('customer_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    rows.push(...(data as Row[]));
    if (data.length < PAGE) break;
  }

  const byName = new Map<string, Row[]>();
  for (const r of rows) {
    const k = nameKey(r.name);
    if (!k) continue; // blank names never group
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(r);
  }
  const candidateGroups = [...byName.entries()].filter(([, rs]) => rs.length >= 2);
  if (candidateGroups.length === 0) return [];

  // 2) annotate every candidate, then keep only groups that still hold a likely stray (no-orders member)
  const annotated = await annotateMembers(supabase, candidateGroups.flatMap(([, rs]) => rs));
  const memberById = new Map(annotated.map((m) => [m.id, m]));
  const groups: DuplicateGroup[] = [];
  for (const [key, rs] of candidateGroups) {
    const members = rs.map((r) => memberById.get(r.customer_id)).filter((m): m is DuplicateMember => !!m);
    if (!members.some((m) => m.order_count === 0)) continue; // both real & distinct → not a split
    // keeper-first ordering (most orders, then most spend) so the UI's default primary is the real one
    members.sort((a, b) => b.order_count - a.order_count || b.lifetime_spend - a.lifetime_spend);
    groups.push({ key, name: rs.find((r) => r.name?.trim())?.name ?? rs[0].name ?? '(no name)', members });
  }
  // most-fragmented first, then alphabetical
  groups.sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return groups;
}

// By-ID search (merge mode 2): find customers by customer_id / name / phone digits, annotated like the
// scan — so the operator can hand-pick a keeper + the records to absorb even when the names don't match
// (the import split one person across several phone-keyed rows, e.g. Henny Y 1299 / 7970 / 6638).
export async function findCustomersForMerge(query: string): Promise<DuplicateMember[]> {
  const supabase = createSupabaseServerClient();
  const raw = sanitizeSearch(query);
  if (raw.length < 2) return [];
  const digits = raw.replace(/\D/g, '');
  const filters = [`name.ilike.%${raw}%`, `phone_raw.ilike.%${raw}%`];
  if (digits.length >= 2) filters.push(`phone.ilike.%${digits}%`, `phone2.ilike.%${digits}%`, `phone3.ilike.%${digits}%`);
  const asId = Number(raw);
  if (Number.isInteger(asId) && asId > 0) filters.push(`customer_id.eq.${asId}`);
  const { data } = await supabase.from('customers').select(PHONE_COLS).or(filters.join(',')).limit(40);
  const members = await annotateMembers(supabase, (data ?? []) as CustPhoneRow[]);
  members.sort((a, b) => b.order_count - a.order_count || b.lifetime_spend - a.lifetime_spend);
  return members;
}

// ── Data health (PR107): read-only integrity scan over the customer table ──
// The signature of the import's phone-split is one normalized number sitting on more than one
// customer row — names alone miss it. We union customers that share any number into groups, and flag
// the ones where consolidating would overflow the three phone slots (a manual number choice).
export async function getDataHealth(): Promise<DataHealth> {
  const supabase = createSupabaseServerClient();
  type HealthRow = CustPhoneRow & { channels: unknown };
  const rows: HealthRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('customers').select(`${PHONE_COLS},channels`).order('customer_id', { ascending: true }).range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    rows.push(...(data as HealthRow[]));
    if (data.length < PAGE) break;
  }

  const noName = rows.filter((r) => !(r.name ?? '').trim()).length;
  // names that are missing the legacy "(last4)" code (have a primary number + a name, no trailing code)
  const missingCode = rows.filter((r) => needsNameCode(r.name, r.phone)).length;

  // union-find over customer ids, joined whenever two rows share a normalized number
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(x) !== r) { const n = parent.get(x)!; parent.set(x, r); x = n; }
    return r;
  };
  const union = (a: number, b: number) => { parent.set(find(a), find(b)); };
  for (const r of rows) parent.set(r.customer_id, r.customer_id);
  const phoneToFirst = new Map<string, number>();
  const rowPhones = (r: CustPhoneRow) => [r.phone, r.phone2, r.phone3].filter((p): p is string => !!p);
  for (const r of rows) {
    for (const p of rowPhones(r)) {
      const first = phoneToFirst.get(p);
      if (first == null) phoneToFirst.set(p, r.customer_id);
      else union(first, r.customer_id);
    }
  }

  const byRoot = new Map<number, CustPhoneRow[]>();
  for (const r of rows) {
    if (rowPhones(r).length === 0) continue; // only group records that carry a number
    const root = find(r.customer_id);
    (byRoot.get(root) ?? byRoot.set(root, []).get(root)!).push(r);
  }

  const groups: DataHealthGroup[] = [];
  for (const members of byRoot.values()) {
    if (members.length < 2) continue;
    const allPhones = new Set<string>();
    for (const m of members) for (const p of rowPhones(m)) allPhones.add(p);
    const shared = [...allPhones].filter((p) => members.filter((m) => rowPhones(m).includes(p)).length > 1);
    groups.push({
      memberIds: members.map((m) => m.customer_id),
      members: members.map((m) => ({ id: m.customer_id, name: m.name, phones: [m.phone_raw ?? m.phone, m.phone2_raw ?? m.phone2, m.phone3_raw ?? m.phone3].filter((p): p is string => !!p) })),
      sharedPhones: shared.length ? shared : [...allPhones].slice(0, 1),
      numberCount: allPhones.size,
    });
  }
  groups.sort((a, b) => b.numberCount - a.numberCount || b.memberIds.length - a.memberIds.length);
  const rowById = new Map(rows.map((r) => [r.customer_id, r]));
  const phonesOf = (id: number): string[] => {
    const r = rowById.get(id);
    return r ? [r.phone_raw ?? r.phone, r.phone2_raw ?? r.phone2, r.phone3_raw ?? r.phone3].filter((p): p is string => !!p) : [];
  };

  // ── shared-address groups: union customers that share a normalized address (name/number-independent)
  const addrRows: { customer_id: number; raw_address: string | null; street: string | null; kelurahan: string | null; kecamatan: string | null; kota: string | null; provinsi: string | null; negara: string | null; kode_pos: string | null }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('customer_addresses')
      .select('customer_id,raw_address,street,kelurahan,kecamatan,kota,provinsi,negara,kode_pos')
      .order('address_id', { ascending: true }).range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    addrRows.push(...(data as typeof addrRows));
    if (data.length < PAGE) break;
  }
  const addrCount = new Map<number, number>();
  for (const a of addrRows) addrCount.set(a.customer_id, (addrCount.get(a.customer_id) ?? 0) + 1);

  const aparent = new Map<number, number>();
  const afind = (x: number): number => { let r = x; while (aparent.get(r) !== r) r = aparent.get(r)!; while (aparent.get(x) !== r) { const n = aparent.get(x)!; aparent.set(x, r); x = n; } return r; };
  const aunion = (a: number, b: number) => { aparent.set(afind(a), afind(b)); };
  for (const r of rows) aparent.set(r.customer_id, r.customer_id);
  const keyFirst = new Map<string, number>();
  const keyText = new Map<string, string>();
  const custKeys = new Map<number, Set<string>>();
  for (const a of addrRows) {
    if (!aparent.has(a.customer_id)) continue;
    const k = addressKey(a);
    if (!k.replace(/\|/g, '').trim()) continue;           // skip blank addresses
    keyText.set(k, a.raw_address || k);
    (custKeys.get(a.customer_id) ?? custKeys.set(a.customer_id, new Set()).get(a.customer_id)!).add(k);
    const first = keyFirst.get(k);
    if (first == null) keyFirst.set(k, a.customer_id);
    else if (first !== a.customer_id) aunion(first, a.customer_id);
  }
  const aByRoot = new Map<number, number[]>();
  for (const cid of custKeys.keys()) (aByRoot.get(afind(cid)) ?? aByRoot.set(afind(cid), []).get(afind(cid))!).push(cid);
  const phoneGroupKeys = new Set(groups.map((g) => g.memberIds.slice().sort((a, b) => a - b).join(',')));
  const addressGroups: AddressDupGroup[] = [];
  for (const ids of aByRoot.values()) {
    if (ids.length < 2) continue;
    if (phoneGroupKeys.has(ids.slice().sort((a, b) => a - b).join(','))) continue; // already a shared-number group
    const keyCount = new Map<string, number>();
    for (const id of ids) for (const k of custKeys.get(id) ?? []) keyCount.set(k, (keyCount.get(k) ?? 0) + 1);
    let sharedAddress = '';
    for (const [k, c] of keyCount) if (c > 1) { sharedAddress = keyText.get(k) ?? k; break; }
    addressGroups.push({
      memberIds: ids,
      members: ids.map((id) => ({ id, name: rowById.get(id)?.name ?? null, phones: phonesOf(id) })),
      sharedAddress: sharedAddress || '(shared address)',
    });
  }
  addressGroups.sort((a, b) => b.memberIds.length - a.memberIds.length);

  // ── empty strays: no number, no address, no channels, and (verified) no orders/operational refs
  const candidates = rows.filter((r) => rowPhones(r).length === 0
    && (addrCount.get(r.customer_id) ?? 0) === 0
    && !(Array.isArray(r.channels) ? r.channels : []).some((c) => c && typeof c === 'object' && (c as { platform?: unknown }).platform));
  const candIds = candidates.map((r) => r.customer_id);
  const referenced = new Set<number>();
  for (const table of ['orders', 'holds', 'outbound_shipments', 'purchase_orders', 'missing_pieces'] as const) {
    const found = await chunked(candIds, 200, async (slice) => {
      const { data } = await supabase.from(table).select('customer_id').in('customer_id', slice);
      return (data ?? []) as { customer_id: number }[];
    });
    for (const f of found) referenced.add(f.customer_id);
  }
  const emptyStrays: EmptyStray[] = candidates.filter((r) => !referenced.has(r.customer_id)).map((r) => ({ id: r.customer_id, name: r.name }));

  return {
    totalCustomers: rows.length,
    noName,
    missingCode,
    sharedPhoneGroupCount: groups.length,
    overThreeCount: groups.filter((g) => g.numberCount > 3).length,
    groups: groups.slice(0, 200),
    sharedAddressGroupCount: addressGroups.length,
    addressGroups: addressGroups.slice(0, 200),
    emptyStrayCount: emptyStrays.length,
    emptyStrays: emptyStrays.slice(0, 200),
  };
}

// Backfill the legacy "(last4)" code into customers.name (e.g. "Henny Y" → "Henny Y (1299)"), one page
// of `customer_id` at a time so the UI can loop it to completion. Idempotent: names that already carry a
// code, or have no primary number / no name, are skipped. The new name flows to all sales history live.
export async function addNameCodes(afterId = 0): Promise<{ updated: number; lastId: number; done: boolean }> {
  const supabase = createSupabaseServerClient();
  const PAGE = 500;
  const { data } = await supabase.from('customers').select('customer_id,name,phone')
    .gt('customer_id', afterId).order('customer_id', { ascending: true }).limit(PAGE);
  const rows = (data ?? []) as { customer_id: number; name: string | null; phone: string | null }[];
  const todo = rows.filter((r) => needsNameCode(r.name, r.phone));
  let updated = 0;
  for (let i = 0; i < todo.length; i += 25) {
    await Promise.all(todo.slice(i, i + 25).map(async (r) => {
      const { error } = await supabase.from('customers').update({ name: `${(r.name ?? '').trim()} (${phoneCode(r.phone)})` }).eq('customer_id', r.customer_id);
      if (!error) updated += 1;
    }));
  }
  return { updated, lastId: rows.length ? rows[rows.length - 1].customer_id : afterId, done: rows.length < PAGE };
}

// Load specific customers as merge candidates (Data health deep-links a group's exact member ids into
// the merge tool, instead of a fuzzy search).
export async function getMergeCandidatesByIds(ids: number[]): Promise<DuplicateMember[]> {
  if (!ids.length) return [];
  const supabase = createSupabaseServerClient();
  const { data } = await supabase.from('customers').select(PHONE_COLS).in('customer_id', ids);
  const members = await annotateMembers(supabase, (data ?? []) as CustPhoneRow[]);
  members.sort((a, b) => b.order_count - a.order_count || b.lifetime_spend - a.lifetime_spend);
  return members;
}

// Bulk-delete empty stray customers (Data health). Re-verifies each id has no orders/addresses/
// operational rows server-side and skips any that do, so nothing with attached data is ever removed.
export async function deleteEmptyStrays(ids: number[]): Promise<{ deleted: number; skipped: number }> {
  if (!ids.length) return { deleted: 0, skipped: 0 };
  const supabase = createSupabaseServerClient();
  const referenced = new Set<number>();
  for (const table of ['orders', 'holds', 'outbound_shipments', 'purchase_orders', 'missing_pieces', 'customer_addresses'] as const) {
    const found = await chunked(ids, 200, async (slice) => {
      const { data } = await supabase.from(table).select('customer_id').in('customer_id', slice);
      return (data ?? []) as { customer_id: number }[];
    });
    for (const f of found) referenced.add(f.customer_id);
  }
  const deletable = ids.filter((id) => !referenced.has(id));
  if (deletable.length) {
    const { error } = await supabase.from('customers').delete().in('customer_id', deletable);
    if (error) throw new Error(`deleteEmptyStrays: ${error.message}`);
  }
  return { deleted: deletable.length, skipped: ids.length - deletable.length };
}

// Merge `duplicateIds` into `primaryId`: pull each stray's phones into the primary's free slots (de-duped,
// max three), move its addresses across (skipping ones the primary already has), re-point every FK row
// (orders / shipments / holds / POs / missing-pieces) at the primary, then delete the stray rows.
export async function mergeCustomers(primaryId: number, duplicateIds: number[], keepName?: string): Promise<MergeResult> {
  const supabase = createSupabaseServerClient();
  const dupIds = duplicateIds.filter((id) => id !== primaryId);
  if (dupIds.length === 0) throw new Error('mergeCustomers: nothing to merge.');

  const allIds = [primaryId, ...dupIds];
  const { data: custRows, error: custErr } = await supabase.from('customers').select('*').in('customer_id', allIds);
  if (custErr) throw new Error(`mergeCustomers: ${custErr.message}`);
  const byId = new Map<number, Customer>((custRows ?? []).map((c) => [c.customer_id, c as Customer]));
  const primary = byId.get(primaryId);
  if (!primary) throw new Error('mergeCustomers: primary customer not found.');
  const dups = dupIds.map((id) => byId.get(id)).filter((c): c is Customer => !!c);

  // 1) re-point FK rows at the primary (before delete, so nothing is orphaned or cascade-deleted)
  let recordsReassigned = 0;
  for (const table of ['orders', 'holds', 'outbound_shipments', 'purchase_orders', 'missing_pieces'] as const) {
    const { data, error } = await supabase.from(table).update({ customer_id: primaryId }).in('customer_id', dupIds).select('customer_id');
    if (error) throw new Error(`mergeCustomers (${table}): ${error.message}`);
    recordsReassigned += data?.length ?? 0;
  }

  // 2) move addresses across, skipping any the primary already has
  const { data: primAddrs } = await supabase.from('customer_addresses').select('*').eq('customer_id', primaryId);
  const seenAddr = new Set((primAddrs ?? []).map((a) => addressKey(a as CustomerAddress)));
  const { data: dupAddrs } = await supabase.from('customer_addresses').select('*').in('customer_id', dupIds);
  let addressesMoved = 0;
  let addressesSkipped = 0;
  for (const a of (dupAddrs ?? []) as CustomerAddress[]) {
    const k = addressKey(a);
    if (seenAddr.has(k)) {
      await supabase.from('customer_addresses').delete().eq('address_id', a.address_id);
      addressesSkipped += 1;
    } else {
      const { error } = await supabase.from('customer_addresses').update({ customer_id: primaryId }).eq('address_id', a.address_id);
      if (error) throw new Error(`mergeCustomers (address): ${error.message}`);
      seenAddr.add(k);
      addressesMoved += 1;
    }
  }

  // 3) collect phones (primary first to preserve #1), de-duped by normalized form, into ≤3 slots
  const slots: { norm: string; raw: string | null }[] = [];
  const seenPhone = new Set<string>();
  const addPhone = (norm: string | null, raw: string | null) => {
    if (!norm || seenPhone.has(norm)) return;
    seenPhone.add(norm);
    if (slots.length < 3) slots.push({ norm, raw: raw ?? norm });
  };
  for (const c of [primary, ...dups]) {
    addPhone(c.phone, c.phone_raw);
    addPhone(c.phone2, c.phone2_raw);
    addPhone(c.phone3, c.phone3_raw);
  }
  const before = new Set([primary.phone, primary.phone2, primary.phone3].filter(Boolean) as string[]);
  const phonesAdded = slots.filter((s) => !before.has(s.norm)).length;
  const droppedPhones = Math.max(0, seenPhone.size - slots.length);

  // 3b) collect channels (primary first), de-duped by platform+handle, into ≤3 slots (the editor's cap)
  const chanKey = (c: CustomerChannel) => `${(c.platform || '').toLowerCase().trim()}|${(c.handle || '').toLowerCase().trim()}`;
  const channelsOut: CustomerChannel[] = [];
  const seenChan = new Set<string>();
  for (const c of [primary, ...dups]) {
    for (const ch of Array.isArray(c.channels) ? c.channels : []) {
      if (!ch || !ch.platform) continue;
      const k = chanKey(ch);
      if (seenChan.has(k)) continue;
      seenChan.add(k);
      if (channelsOut.length < 3) channelsOut.push({ platform: String(ch.platform), handle: String(ch.handle ?? '') });
    }
  }
  const channelsBefore = (Array.isArray(primary.channels) ? primary.channels : []).filter((c) => c && c.platform).length;
  const channelsAdded = Math.max(0, channelsOut.length - channelsBefore);

  // 4) delete the strays, THEN write the merged phones + channels onto the primary (no row holds the
  //    phones anymore, so the unique `phone` index can't collide)
  const { error: delErr } = await supabase.from('customers').delete().in('customer_id', dupIds);
  if (delErr) throw new Error(`mergeCustomers (delete): ${delErr.message}`);

  const update: Record<string, unknown> = {
    phone: slots[0]?.norm ?? null, phone_raw: slots[0]?.raw ?? null,
    phone2: slots[1]?.norm ?? null, phone2_raw: slots[1]?.raw ?? null,
    phone3: slots[2]?.norm ?? null, phone3_raw: slots[2]?.raw ?? null,
    channels: channelsOut,
  };
  // optional: rename the keeper as part of the merge (e.g. "Lina Wong / Ita" so it's searchable by
  // either name). The new name flows to all sales history live, since every list resolves it by id.
  if (keepName !== undefined) update.name = keepName.trim() || null;
  const { error: updErr } = await supabase.from('customers').update(update).eq('customer_id', primaryId);
  if (updErr) throw new Error(`mergeCustomers (phones): ${updErr.message}`);

  return { primaryId, removedIds: dupIds, phonesAdded, droppedPhones, channelsAdded, addressesMoved, addressesSkipped, recordsReassigned };
}

// Delete a customer outright (the detail "Delete customer ID" button). Refuses when the record is
// still referenced by any sales/operational row — those must be merged into another customer, never
// orphaned. Addresses fall away via the customer_addresses ON DELETE CASCADE (0004).
export async function deleteCustomer(customerId: number): Promise<void> {
  const supabase = createSupabaseServerClient();
  const guards: { table: 'orders' | 'holds' | 'outbound_shipments' | 'purchase_orders' | 'missing_pieces'; label: string }[] = [
    { table: 'orders', label: 'order' },
    { table: 'holds', label: 'hold' },
    { table: 'outbound_shipments', label: 'shipment' },
    { table: 'purchase_orders', label: 'purchase order' },
    { table: 'missing_pieces', label: 'missing-piece report' },
  ];
  for (const g of guards) {
    const { count, error } = await supabase.from(g.table).select('customer_id', { count: 'exact', head: true }).eq('customer_id', customerId);
    if (error) throw new Error(`deleteCustomer (${g.table}): ${error.message}`);
    if ((count ?? 0) > 0) {
      throw new Error(`This customer is on ${count} ${g.label}${count === 1 ? '' : 's'} — merge it into another record instead of deleting.`);
    }
  }
  const { error } = await supabase.from('customers').delete().eq('customer_id', customerId);
  if (error) throw new Error(`deleteCustomer: ${error.message}`);
}
