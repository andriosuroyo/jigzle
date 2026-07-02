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
  ReverseResult,
  ShipIdSuggestion,
  InboundHistoryRow,
  InboundHistoryItem,
} from './types';

type Supabase = ReturnType<typeof createSupabaseServerClient>;

const QUEUE_LIMIT = 100;
const HISTORY_ROW_SCAN = 12000; // inbound rows scanned (paged, 1000/batch) to build the History tab before grouping
const HISTORY_LIMIT = 100;     // shipments shown in History

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
      sku_codes: [...expected].sort((a, b) => a.localeCompare(b)),
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

// ── Inbound History: confirmed receipts grouped per ship_id, newest first (types in ./types) ──
// Reads the inbound ledger (the canonical "what arrived"), skipping opening balances. Groups by
// ship_id, sums sellable qty per SKU, resolves names in one catalogue round-trip, and tags whether a
// ship_id is a real shipment (origin/tracking) or a 📦 ad-hoc receive. Search filters the grouped
// rows by ship_id / SKU code / name (the field is optional — '' returns the newest shipments).
export async function getReceiveHistory(query: string): Promise<InboundHistoryRow[]> {
  const supabase = createSupabaseServerClient();
  const q = sanitize(query).toLowerCase();

  // PostgREST caps a single response at 1000 rows regardless of .limit(), which silently truncated the
  // scan and dropped older receipts from History (a SKU's earlier shipments would just vanish). Page
  // through in 1000-row batches (stable order: receive_date, then inbound_id) up to HISTORY_ROW_SCAN.
  type Row = { item_code: string | null; item_code_raw: string | null; qty: number; excluded_qty: number | null; ship_id: string | null; receive_date: string | null; created_at: string | null; staff: string | null };
  const PAGE = 1000;
  const rows: Row[] = [];
  // `staff` is new (0052) — degrade gracefully if the migration isn't applied yet so History never
  // goes blank in the deploy→migrate window (drop the column from the select and retry once).
  let cols = 'item_code,item_code_raw,qty,excluded_qty,ship_id,receive_date,created_at,staff';
  for (let from = 0; from < HISTORY_ROW_SCAN; from += PAGE) {
    const { data, error } = await supabase
      .from('inbound')
      .select(cols)
      .eq('is_opening_balance', false)
      .not('ship_id', 'is', null)
      .order('receive_date', { ascending: false, nullsFirst: false })
      .order('inbound_id', { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      if (cols.includes(',staff')) { cols = cols.replace(',staff', ''); from -= PAGE; continue; } // retry same page sans staff
      break;
    }
    const page = (data ?? []) as unknown as Row[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  if (!rows.length) return [];

  // resolve names for every candidate code. A single .in() over ALL distinct codes builds a huge URL
  // that PostgREST rejects (3k+ codes → a 60KB+ query string → the request FAILS), which silently left
  // nameByCode empty so every History name fell back to the raw item_code. Batch the lookup in ≤200-code
  // chunks so every name resolves.
  const codes = [...new Set(rows.map((r) => r.item_code).filter((c): c is string => !!c))];
  const nameByCode = new Map<string, string>();
  const CHUNK = 200;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const { data: cat } = await supabase
      .from('catalogue')
      .select('item_code,translate_name,original_name,self_code')
      .in('item_code', codes.slice(i, i + CHUNK));
    for (const c of (cat ?? []) as CatNameRow[]) nameByCode.set(c.item_code, nameOf(c, c.item_code));
  }

  // group by ship_id → per-SKU summed qty + latest receive_date. Track the latest created_at (drives the
  // date+time display) and the staff on that latest row (who received).
  type Group = { ship_id: string; receive_date: string | null; received_at: string | null; staff: string | null; items: Map<string, InboundHistoryItem> };
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const sid = r.ship_id as string;
    const g = groups.get(sid) ?? groups.set(sid, { ship_id: sid, receive_date: null, received_at: null, staff: null, items: new Map() }).get(sid)!;
    if (r.receive_date && (!g.receive_date || r.receive_date > g.receive_date)) g.receive_date = r.receive_date;
    if (r.created_at && (!g.received_at || r.created_at > g.received_at)) { g.received_at = r.created_at; g.staff = r.staff ?? g.staff; }
    const key = r.item_code ?? `raw:${r.item_code_raw ?? ''}`;
    const name = r.item_code ? nameByCode.get(r.item_code) ?? r.item_code : r.item_code_raw ?? '(unnamed)';
    const excl = Number(r.excluded_qty ?? 0) || 0;
    const sellable = (Number(r.qty ?? 0) || 0) - excl;
    const cur = g.items.get(key);
    if (cur) { cur.qty += sellable; cur.excluded_qty += excl; }
    else g.items.set(key, { item_code: r.item_code, name, qty: sellable, excluded_qty: excl });
  }

  let out: InboundHistoryRow[] = [...groups.values()].map((g) => {
    const items = [...g.items.values()].sort((a, b) => a.name.localeCompare(b.name));
    const sku_codes = items.map((i) => i.item_code).filter((c): c is string => !!c).sort((a, b) => a.localeCompare(b));
    return {
      ship_id: g.ship_id,
      receive_date: g.receive_date,
      received_at: g.received_at,
      staff: g.staff,
      origin_country: null, // meta filled in below for the final (sliced) rows only
      tracking: null,
      is_adhoc: false,
      items,
      sku_codes,
      item_count: items.length,
      total_qty: items.reduce((s, i) => s + i.qty, 0),
    };
  });

  if (q) {
    out = out.filter(
      (r) =>
        r.ship_id.toLowerCase().includes(q) ||
        r.sku_codes.some((c) => c.toLowerCase().includes(q)) ||
        r.items.some((i) => i.name.toLowerCase().includes(q))
    );
  }

  // newest first (nulls last); ship_id tiebreak for stable order
  out.sort((a, b) => {
    if (a.receive_date && b.receive_date) return a.receive_date < b.receive_date ? 1 : a.receive_date > b.receive_date ? -1 : a.ship_id.localeCompare(b.ship_id);
    if (a.receive_date) return -1;
    if (b.receive_date) return 1;
    return a.ship_id.localeCompare(b.ship_id);
  });
  out = out.slice(0, HISTORY_LIMIT);

  // shipment meta (origin / tracking) for ONLY the visible rows — bounds the .in() to ≤100 ids (a
  // 200-id .in() over the full scan was silently failing, mislabelling real shipments as "unmarked").
  // A ship_id with no shipments-ledger row is an unmarked (📦) receive.
  const shipIds = out.map((r) => r.ship_id);
  if (shipIds.length) {
    const { data: ships } = await supabase
      .from('shipments')
      .select('ship_id,origin_country,tracking')
      .in('ship_id', shipIds);
    const metaByShip = new Map<string, { origin_country: string | null; tracking: string | null }>();
    for (const s of (ships ?? []) as { ship_id: string; origin_country: string | null; tracking: string | null }[]) {
      metaByShip.set(s.ship_id, { origin_country: s.origin_country ?? null, tracking: s.tracking ?? null });
    }
    for (const r of out) {
      const meta = metaByShip.get(r.ship_id);
      r.origin_country = meta?.origin_country ?? null;
      r.tracking = meta?.tracking ?? null;
      r.is_adhoc = !meta;
    }
  }
  return out;
}

// ── delete an Inbound History entry: remove every inbound row for a ship_id. stock_check is a view
// over inbound, so deleting the rows reverses the stock those receipts added (no separate undo). This
// does NOT reopen a closed shipment or restore PO status — it's a record-correction for receives. ──
export async function deleteInboundShipment(shipId: string): Promise<{ deleted: number }> {
  const sid = shipId.trim();
  if (!sid) throw new Error('deleteInboundShipment: a ship id is required');
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('inbound')
    .delete()
    .eq('ship_id', sid)
    .eq('is_opening_balance', false)
    .select('inbound_id');
  if (error) throw new Error(`deleteInboundShipment: ${error.message}`);
  return { deleted: (data ?? []).length };
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

// ── manual SKU search — ONE round-trip via the shared search_skus RPC (PR28; the SAME function
// Sales and Stock Check call, so no drift). Word-split match (item_code OR translate_name OR
// piece_count), exact item_code first, available + on_the_way from the stock_snapshot matview, cap
// 20. SECURITY INVOKER → the same RLS (is_allowed_user) that gated the old direct selects applies.
// 3-char floor so the 0025 pg_trgm GIN index is eligible. Barcode resolution is UNCHANGED — it lives
// in the separate doScan → resolveBarcode path (this manual field never matched barcodes). (SkuHit in ./types)
export async function searchSkus(q: string): Promise<SkuHit[]> {
  const raw = sanitize(q);
  if (raw.length < 3) return []; // <3 chars can't use the pg_trgm index → don't bother the DB
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase.rpc('search_skus', { p_q: raw });
  if (error) return []; // search failures are non-fatal (same posture as before)
  return (data ?? []) as SkuHit[];
}

// ── map a preliminary/placeholder PO code to its real SKU at receive time ──
// A PO can be bought under a provisional code (e.g. 'GUBU-mickey500p') that doesn't follow the SKU
// format and never FK'd to the catalogue (item_code NULL, the placeholder held in item_code_raw). When
// the goods arrive and the real SKU is known (box/barcode), this relinks every not-yet-received PO on
// the shipment that carried that placeholder to the real item_code, so it allocates + closes like any
// resolved line. item_code_raw is KEPT as provenance (the original preliminary code) — never shown once
// item_code is set. The target SKU must already exist (the caller creates a stub first for a new code).
export async function mapPlaceholderPO(shipId: string, rawCode: string, itemCode: string): Promise<{ updated: number }> {
  const sid = shipId.trim();
  const raw = rawCode.trim();
  const code = itemCode.trim();
  if (!sid || !raw || !code) throw new Error('mapPlaceholderPO: ship id, placeholder, and item code are required');
  const supabase = createSupabaseServerClient();

  const { data: cat } = await supabase.from('catalogue').select('item_code').eq('item_code', code).maybeSingle();
  if (!cat) throw new Error(`mapPlaceholderPO: ${code} is not in the catalogue`);

  const { data, error } = await supabase
    .from('purchase_orders')
    .update({ item_code: code })
    .eq('ship_id', sid)
    .is('item_code', null)
    .eq('item_code_raw', raw)
    .or('status.is.null,status.neq.Received')
    .select('po_id');
  if (error) throw new Error(`mapPlaceholderPO: ${error.message}`);
  return { updated: (data ?? []).length };
}

// ── link a barcode to a SKU (used when mapping a placeholder at receive: the box's barcode is the
// identifier, so linking it means future receives of the same item auto-resolve via the scan path).
// Idempotent: a duplicate (barcode, item_code) link (0020 composite PK) is a no-op, not an error.
// is_verified false — it's an operator-entered link, same posture as a stub's barcode.
export async function linkBarcode(barcode: string, itemCode: string): Promise<{ linked: boolean }> {
  const bc = barcode.trim();
  const code = itemCode.trim();
  if (!bc || !code) return { linked: false };
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from('barcodes').insert({ barcode: bc, item_code: code, is_verified: false });
  if (error && error.code !== '23505') throw new Error(`linkBarcode: ${error.message}`);
  return { linked: true };
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

  return { item_code, name: name ?? item_code, available: 0, on_the_way: 0 };
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
      excluded_qty: l.excluded_qty,
      exclude_reason: l.exclude_reason,
      label: l.label,
      dimension_weight: l.dimension_weight,
    })),
    p_close_shipment: payload.close_shipment,
  });
  if (error) throw new Error(`recordReceipt: ${error.message}`);

  // 0023 returns jsonb {receipt_id, affected, closed} (was a bare text[] in 0015).
  const out = (data as { receipt_id: number; affected: string[]; closed: boolean } | null) ?? {
    receipt_id: 0,
    affected: [],
    closed: false,
  };

  // 0052: stamp the active warehouse staff onto this receipt's inbound rows (targeted by receipt_id, so
  // the big record_receipt RPC stays untouched). Non-fatal — a failed stamp never voids a real receipt.
  const staff = payload.staff?.trim();
  if (staff && out.receipt_id) {
    await supabase.from('inbound').update({ staff }).eq('receipt_id', out.receipt_id);
  }

  const affected = out.affected ?? [];
  let stock: RecordReceiptResult['stock'] = [];
  if (affected.length) {
    const { data: s } = await supabase
      .from('stock_check')
      .select('item_code,available,physical,last_receive')
      .in('item_code', affected);
    stock = (s ?? []) as RecordReceiptResult['stock'];
  }
  return { receipt_id: out.receipt_id, closed: out.closed, affected, stock };
}

// ── reverse a confirmed receipt (mis-count recovery, via reverse_receipt) → refreshed stock ──
export async function reverseReceipt(receiptId: number): Promise<ReverseResult> {
  if (!receiptId) throw new Error('reverseReceipt: a receipt id is required');
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase.rpc('reverse_receipt', { p_receipt_id: receiptId, p_note: 'Reverse action' });
  if (error) throw new Error(`reverseReceipt: ${error.message}`);

  const out = (data as { receipt_id: number; affected: string[] } | null) ?? { receipt_id: receiptId, affected: [] };
  const affected = out.affected ?? [];
  let stock: ReverseResult['stock'] = [];
  if (affected.length) {
    const { data: s } = await supabase
      .from('stock_check')
      .select('item_code,available,physical,last_receive')
      .in('item_code', affected);
    stock = (s ?? []) as ReverseResult['stock'];
  }
  return { receipt_id: out.receipt_id, affected, stock };
}

// ── §5 ship-id suggestion: a scanned SKU → open ship_ids with an open PO line for it (no RPC) ──
// Joins open POs (status <> 'Received', ship_id not null) for the SKU to OPEN shipments, oldest
// shipment first. Returns candidates for the operator to confirm; the caller preselects if exactly one.
export async function suggestShipIds(itemCode: string): Promise<ShipIdSuggestion[]> {
  const code = itemCode.trim();
  if (!code) return [];
  const supabase = createSupabaseServerClient();

  // open PO lines for this SKU that are attached to a shipment, summed per ship_id.
  const { data: pos } = await supabase
    .from('purchase_orders')
    .select('ship_id,qty,status')
    .eq('item_code', code)
    .not('ship_id', 'is', null)
    .or('status.is.null,status.neq.Received');
  const byShip = new Map<string, number>();
  for (const p of (pos ?? []) as { ship_id: string | null; qty: number | null }[]) {
    if (!p.ship_id) continue;
    byShip.set(p.ship_id, (byShip.get(p.ship_id) ?? 0) + (Number(p.qty) || 0));
  }
  if (byShip.size === 0) return [];

  // keep only OPEN shipments (an open PO line could point at an already-completed ship_id).
  const { data: ships } = await supabase
    .from('shipments')
    .select('ship_id,origin_country,ship_date,status')
    .in('ship_id', [...byShip.keys()])
    .eq('status', 'open');

  const rows: ShipIdSuggestion[] = ((ships ?? []) as {
    ship_id: string;
    origin_country: string | null;
    ship_date: string | null;
  }[]).map((s) => ({
    ship_id: s.ship_id,
    origin_country: s.origin_country ?? null,
    ship_date: s.ship_date ?? null,
    open_qty: byShip.get(s.ship_id) ?? 0,
  }));

  // oldest shipment first (nulls last); ship_id tiebreak for stable order.
  rows.sort((a, b) => {
    if (a.ship_date && b.ship_date) return a.ship_date < b.ship_date ? -1 : a.ship_date > b.ship_date ? 1 : a.ship_id.localeCompare(b.ship_id);
    if (a.ship_date) return -1;
    if (b.ship_date) return 1;
    return a.ship_id.localeCompare(b.ship_id);
  });
  return rows;
}
