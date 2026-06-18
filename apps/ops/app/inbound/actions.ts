'use server';

// Server actions for the Receiving (Inbound) module (J2 — the "+" side of stock). Same auth
// posture as the sales/fulfill/outbound actions: the SSR supabase client (anon key + the
// signed-in user's session), so RLS (is_allowed_user()) gates every read and write. The
// service-role key is never used here (the smoke harness uses it as a TEST harness only).

import { createSupabaseServerClient } from '@jigzle/db/server';
import type { ExpectedLine, ReceiveQueueRow, ShipmentContentLine } from '@jigzle/db/types';
import type {
  ReceiveDetail,
  ResolvedSku,
  ResolveResult,
  SkuHit,
  StubInput,
  RecordReceiptInput,
  RecordReceiptResult,
} from './types';

type Supabase = ReturnType<typeof createSupabaseServerClient>;

const QUEUE_LIMIT = 100;

// PostgREST `.or()` / `.ilike()` interpolate the raw string into a filter grammar where
// , ( ) * \ are operators. Strip them from operator-typed input (defense-in-depth — the
// operator is trusted, but never build a filter from unsanitized text).
function sanitize(q: string): string {
  return q.replace(/[,()*\\]/g, ' ').trim();
}

type CatNameRow = {
  item_code: string;
  translate_name: string | null;
  original_name: string | null;
  self_code: string | null;
};

function nameOf(c: CatNameRow | null, fallback: string): string {
  if (!c) return fallback;
  return c.translate_name || c.original_name || c.self_code || fallback;
}

// ── the arrivals queue: open shipments + an expected-SKU count (D3: contents ∪ POs) ──
export async function getReceiveQueue(): Promise<ReceiveQueueRow[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('shipments')
    .select('ship_id,origin_country,ship_date,tracking,contents')
    .eq('status', 'open')
    .is('received_date', null)
    .order('ship_date', { ascending: false, nullsFirst: false })
    .limit(QUEUE_LIMIT);
  if (error || !data) return [];

  const shipIds = data.map((s) => s.ship_id as string);

  // POs on these ship_ids in one round-trip → distinct item_codes per ship_id (D3).
  const poByShip = new Map<string, Set<string>>();
  if (shipIds.length) {
    const { data: pos } = await supabase
      .from('purchase_orders')
      .select('ship_id,item_code')
      .in('ship_id', shipIds);
    for (const p of pos ?? []) {
      const sid = p.ship_id as string | null;
      const code = p.item_code as string | null;
      if (!sid || !code) continue;
      (poByShip.get(sid) ?? poByShip.set(sid, new Set()).get(sid)!).add(code);
    }
  }

  return data.map((s) => {
    const contents = (s.contents ?? []) as ShipmentContentLine[];
    const expected = new Set<string>();
    for (const c of contents) {
      const key = (c.item ?? '').trim();
      if (key) expected.add(key);
    }
    for (const code of poByShip.get(s.ship_id as string) ?? []) expected.add(code);
    return {
      ship_id: s.ship_id as string,
      origin_country: (s.origin_country as string | null) ?? null,
      ship_date: (s.ship_date as string | null) ?? null,
      tracking: (s.tracking as string | null) ?? null,
      expected_count: expected.size,
    };
  });
}

// ── the receive detail: the expected list (contents ∪ POs) + barcodes for scan resolution ── (types in ./types)
export async function getShipmentForReceive(shipId: string): Promise<ReceiveDetail | null> {
  const supabase = createSupabaseServerClient();
  const sid = shipId.trim();
  if (!sid) return null;

  const { data: ship } = await supabase
    .from('shipments')
    .select('ship_id,origin_country,ship_date,tracking,contents')
    .eq('ship_id', sid)
    .maybeSingle();

  const contents = ((ship?.contents ?? []) as ShipmentContentLine[]).filter(Boolean);

  // POs on this ship_id (D3) — group expected qty per resolved item_code.
  const { data: poRows } = await supabase
    .from('purchase_orders')
    .select('item_code,item_code_raw,qty')
    .eq('ship_id', sid);
  const pos = (poRows ?? []) as { item_code: string | null; item_code_raw: string | null; qty: number }[];

  // Resolve names for every candidate code: PO item_codes + contents 'item' strings that
  // might be item_codes. One catalogue round-trip.
  const candidateCodes = new Set<string>();
  for (const p of pos) if (p.item_code) candidateCodes.add(p.item_code);
  for (const c of contents) {
    const k = (c.item ?? '').trim();
    if (k) candidateCodes.add(k);
  }
  const nameByCode = new Map<string, string>();
  const isCatalogueCode = new Set<string>();
  if (candidateCodes.size) {
    const { data: cat } = await supabase
      .from('catalogue')
      .select('item_code,translate_name,original_name,self_code')
      .in('item_code', [...candidateCodes]);
    for (const c of (cat ?? []) as CatNameRow[]) {
      isCatalogueCode.add(c.item_code);
      nameByCode.set(c.item_code, nameOf(c, c.item_code));
    }
  }

  // Merge expected: keyed by resolved item_code (else by the raw label). source tracks origin.
  type Agg = { item_code: string | null; raw: string | null; name: string; expected_qty: number; from_contents: boolean; from_po: boolean };
  const merged = new Map<string, Agg>();
  const bump = (key: string, base: Omit<Agg, 'expected_qty' | 'from_contents' | 'from_po'>, qty: number, src: 'contents' | 'po') => {
    const cur = merged.get(key);
    if (cur) {
      cur.expected_qty += qty;
      if (src === 'contents') cur.from_contents = true;
      else cur.from_po = true;
    } else {
      merged.set(key, { ...base, expected_qty: qty, from_contents: src === 'contents', from_po: src === 'po' });
    }
  };

  for (const c of contents) {
    const item = (c.item ?? '').trim();
    const qty = Number(c.qty ?? 0) || 0;
    if (!item && qty === 0) continue;
    if (isCatalogueCode.has(item)) {
      bump(item, { item_code: item, raw: item, name: nameByCode.get(item) ?? item }, qty, 'contents');
    } else {
      bump(`raw:${item}`, { item_code: null, raw: item || null, name: item || '(unnamed)' }, qty, 'contents');
    }
  }
  for (const p of pos) {
    const qty = Number(p.qty ?? 0) || 0;
    if (p.item_code) {
      bump(p.item_code, { item_code: p.item_code, raw: p.item_code_raw ?? p.item_code, name: nameByCode.get(p.item_code) ?? p.item_code }, qty, 'po');
    } else if (p.item_code_raw) {
      bump(`raw:${p.item_code_raw}`, { item_code: null, raw: p.item_code_raw, name: p.item_code_raw }, qty, 'po');
    }
  }

  const expected: ExpectedLine[] = [...merged.values()].map((a) => ({
    item_code: a.item_code,
    raw: a.raw,
    name: a.name,
    expected_qty: a.expected_qty,
    source: a.from_contents && a.from_po ? 'both' : a.from_po ? 'po' : 'contents',
  }));

  // Barcodes for the resolved expected SKUs — instant client-side scan resolution.
  const expectedCodes = expected.map((e) => e.item_code).filter((c): c is string => !!c);
  let barcodes: { barcode: string; item_code: string }[] = [];
  if (expectedCodes.length) {
    const { data: bc } = await supabase.from('barcodes').select('barcode,item_code').in('item_code', [...new Set(expectedCodes)]);
    barcodes = (bc ?? []) as { barcode: string; item_code: string }[];
  }

  return {
    ship_id: sid,
    origin_country: (ship?.origin_country as string | null) ?? null,
    ship_date: (ship?.ship_date as string | null) ?? null,
    tracking: (ship?.tracking as string | null) ?? null,
    is_shipment: !!ship,
    expected,
    barcodes,
  };
}

// ── scan resolution: barcode → SKU, a collision picker (D1), or not-found (D2) ── (types in ./types)
export async function resolveBarcode(code: string): Promise<ResolveResult> {
  const supabase = createSupabaseServerClient();
  const c = code.trim();
  if (!c) return { status: 'not_found', code: c };

  // Composite (barcode, item_code) model (0020): one barcode can link to many SKUs, so an exact
  // match returns every owner — 0 → not_found, 1 → resolved, >1 → the "which SKU?" picker. The
  // legacy `<code>#<n>` suffix hack is retired with the composite key; the picker now comes
  // honestly from the data. Dedupe by item_code (OR is_verified) is defensive — the composite PK
  // already forbids exact (barcode, item_code) duplicates.
  const { data } = await supabase.from('barcodes').select('item_code,is_verified').eq('barcode', c);

  const byCode = new Map<string, boolean>(); // item_code → is_verified (OR across links)
  for (const row of (data ?? []) as { item_code: string; is_verified: boolean }[]) {
    byCode.set(row.item_code, (byCode.get(row.item_code) ?? false) || row.is_verified);
  }
  const codes = [...byCode.keys()];
  if (!codes.length) return { status: 'not_found', code: c };

  const { data: cat } = await supabase
    .from('catalogue')
    .select('item_code,translate_name,original_name,self_code')
    .in('item_code', codes);
  const nameByCode = new Map<string, string>();
  for (const cc of (cat ?? []) as CatNameRow[]) nameByCode.set(cc.item_code, nameOf(cc, cc.item_code));

  const skus: ResolvedSku[] = codes.map((item_code) => ({
    item_code,
    name: nameByCode.get(item_code) ?? item_code,
    is_verified: byCode.get(item_code) ?? false,
  }));

  return skus.length === 1 ? { status: 'resolved', sku: skus[0] } : { status: 'collision', skus };
}

// ── manual SKU search (catalogue text + barcode), with live available, for adding a line ── (SkuHit in ./types)
export async function searchSkus(q: string): Promise<SkuHit[]> {
  const raw = sanitize(q);
  if (raw.length < 2) return [];
  const supabase = createSupabaseServerClient();

  const named = new Map<string, string>();
  const [catRes, bcRes] = await Promise.all([
    supabase
      .from('catalogue')
      .select('item_code,original_name,translate_name,self_code')
      .or(`item_code.ilike.%${raw}%,self_code.ilike.%${raw}%,original_name.ilike.%${raw}%,translate_name.ilike.%${raw}%`)
      .limit(15),
    supabase.from('barcodes').select('item_code').ilike('barcode', `%${raw}%`).limit(15),
  ]);

  for (const c of (catRes.data ?? []) as CatNameRow[]) named.set(c.item_code, nameOf(c, c.item_code));

  const bcCodes = [...new Set((bcRes.data ?? []).map((b) => b.item_code as string))].filter((code) => !named.has(code));
  if (bcCodes.length) {
    const { data: cat2 } = await supabase
      .from('catalogue')
      .select('item_code,original_name,translate_name,self_code')
      .in('item_code', bcCodes);
    for (const c of (cat2 ?? []) as CatNameRow[]) named.set(c.item_code, nameOf(c, c.item_code));
  }

  const codes = [...named.keys()].slice(0, 20);
  if (!codes.length) return [];

  const { data: stock } = await supabase.from('stock_check').select('item_code,available').in('item_code', codes);
  const avail = new Map((stock ?? []).map((s) => [s.item_code as string, s.available as number]));
  return codes.map((item_code) => ({ item_code, name: named.get(item_code)!, available: avail.get(item_code) ?? 0 }));
}

// ── D2: create a minimal needs_review SKU stub for an unknown barcode ── (StubInput in ./types)
export async function createCatalogueStub(input: StubInput): Promise<SkuHit> {
  const supabase = createSupabaseServerClient();
  const item_code = input.item_code.trim();
  const name = input.name?.trim() || null;
  if (!item_code) throw new Error('createCatalogueStub: item_code is required');

  // never overwrite an existing SKU
  const { data: existing } = await supabase.from('catalogue').select('item_code').eq('item_code', item_code).maybeSingle();
  if (existing) throw new Error(`createCatalogueStub: ${item_code} already exists`);

  // brand_prefix (FK → brands): use the explicit one, else the leading segment if it is a
  // known brand; otherwise leave NULL (the convention isn't universal).
  const candidate = (input.brand_prefix?.trim() || item_code.split('-')[0] || '').trim();
  let brand_prefix: string | null = null;
  if (candidate) {
    const { data: b } = await supabase.from('brands').select('prefix').eq('prefix', candidate).maybeSingle();
    if (b) brand_prefix = candidate;
  }

  const { error } = await supabase
    .from('catalogue')
    .insert({ item_code, brand_prefix, self_code: brand_prefix, translate_name: name, needs_review: true });
  if (error) throw new Error(`createCatalogueStub: ${error.message}`);

  // link the scanned barcode so the line resolves now and future scans hit this SKU
  const bc = input.barcode?.trim();
  if (bc) {
    const { error: bcErr } = await supabase.from('barcodes').insert({ barcode: bc, item_code, is_verified: false });
    if (bcErr && bcErr.code !== '23505') throw new Error(`createCatalogueStub (barcode): ${bcErr.message}`);
  }

  return { item_code, name: name ?? item_code, available: 0 };
}

// ── allocate the next ad-hoc 📦YYMMXXX id (advisory-locked, server-side) ──
export async function newAdhocShipId(): Promise<string> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('next_adhoc_ship_id');
  if (error) throw new Error(`newAdhocShipId: ${error.message}`);
  return data as string;
}

// ── commit the receipt (atomic, via record_receipt) → refreshed stock ── (types in ./types)
export async function recordReceipt(payload: RecordReceiptInput): Promise<RecordReceiptResult> {
  if (!payload.ship_id?.trim()) throw new Error('recordReceipt: a ship id is required');
  if (!payload.lines?.length) throw new Error('recordReceipt: add at least one received line');
  if (!payload.receive_date) throw new Error('recordReceipt: a receive date is required');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('record_receipt', {
    p_ship_id: payload.ship_id.trim(),
    p_receive_date: payload.receive_date,
    p_lines: payload.lines.map((l) => ({
      item_code: l.item_code,
      qty: l.qty,
      excluded: l.excluded,
      label: l.label,
      dimension_weight: l.dimension_weight,
    })),
    p_close_shipment: payload.close_shipment,
  });
  if (error) throw new Error(`recordReceipt: ${error.message}`);

  const affected = (data as string[] | null) ?? [];
  let stock: RecordReceiptResult['stock'] = [];
  if (affected.length) {
    const { data: s } = await supabase
      .from('stock_check')
      .select('item_code,available,physical,last_receive')
      .in('item_code', affected);
    stock = (s ?? []) as RecordReceiptResult['stock'];
  }
  return { affected, stock };
}
