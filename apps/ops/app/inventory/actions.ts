'use server';

// Server actions for the Inventory (Stock Check) screen — READ-ONLY. Same auth posture as the
// other modules: the SSR supabase client (anon key + the signed-in user's session), so RLS
// (is_allowed_user()) gates the live stock_check fallback; the matview is granted to authenticated.
// The service-role key is never used here. No stock-mutating writes live on this screen.

import { createSupabaseServerClient } from '@jigzle/db/server';
import { customerIdLabel } from '@jigzle/lib';
import type { InventoryCounts, InventoryFilter, InventorySortColumn, StockRow } from '@jigzle/db/types';
import type { LedgerEntry, LedgerSku, SkuLedger } from './types';

const LIMIT = 1000; // PostgREST caps responses at max_rows (1000); the operator narrows with search.

const SNAPSHOT_COLS =
  'item_code,name,brand_prefix,pending,on_the_way,physical,available,reserved,on_hold,last_receive,refreshed_at';

// PostgREST `.or()` / `.ilike()` interpolate the raw string into a filter grammar where , ( ) * \
// are operators. Strip them from operator-typed input (defense-in-depth; the operator is trusted).
function sanitize(q: string): string {
  return q.replace(/[,()*\\]/g, ' ').trim();
}

const SORT_COLUMNS: InventorySortColumn[] = [
  'item_code',
  'name',
  'pending',
  'on_the_way',
  'physical',
  'available',
  'last_receive',
];

const STATE_COLUMN: Record<string, 'pending' | 'on_the_way' | 'physical'> = {
  on_order: 'pending',
  shipping: 'on_the_way',
  warehouse: 'physical',
};

// ── the inventory table: reads the active snapshot (fast). search = ilike on code/name; state =
//    the matching column > 0; sortable by any whitelisted column. ──
export async function getInventory(filter?: InventoryFilter): Promise<StockRow[]> {
  const supabase = createSupabaseServerClient();

  let query = supabase.from('stock_snapshot').select(SNAPSHOT_COLS).limit(LIMIT);

  const stateCol = filter?.state && filter.state !== 'all' ? STATE_COLUMN[filter.state] : null;
  if (stateCol) query = query.gt(stateCol, 0);

  const raw = filter?.search ? sanitize(filter.search) : '';
  if (raw.length >= 1) query = query.or(`item_code.ilike.%${raw}%,name.ilike.%${raw}%`);

  const sortCol: InventorySortColumn =
    filter?.sort && SORT_COLUMNS.includes(filter.sort.column) ? filter.sort.column : 'item_code';
  const asc = filter?.sort?.dir !== 'desc';
  query = query.order(sortCol, { ascending: asc, nullsFirst: false });

  const { data, error } = await query;
  if (error || !data) return raw ? deadSkuFallback(supabase, raw) : [];

  const rows = data as StockRow[];
  // Fallback (D2 nicety): a search that matched nothing active may be an exact code for a "dead"
  // SKU (zero on-order/shipping/warehouse) that the snapshot excludes — find it live so any code is
  // visible. Only on an exact item_code match; never widens the active result set.
  if (rows.length === 0 && raw) return deadSkuFallback(supabase, raw);
  return rows;
}

type Supabase = ReturnType<typeof createSupabaseServerClient>;

async function deadSkuFallback(supabase: Supabase, raw: string): Promise<StockRow[]> {
  const code = raw.trim();
  if (!code) return [];
  const { data: s } = await supabase
    .from('stock_check')
    .select('item_code,available,physical,reserved,on_hold,pending,on_the_way,last_receive')
    .eq('item_code', code)
    .maybeSingle();
  if (!s) return [];
  const { data: c } = await supabase
    .from('catalogue')
    .select('translate_name,original_name,brand_prefix')
    .eq('item_code', code)
    .maybeSingle();
  const cat = c as { translate_name: string | null; original_name: string | null; brand_prefix: string | null } | null;
  const row = s as {
    item_code: string;
    available: number;
    physical: number;
    reserved: number;
    on_hold: number;
    pending: number;
    on_the_way: number;
    last_receive: string | null;
  };
  // Stamp the fallback row with the snapshot's REAL "as of", not wall-clock now() — the header
  // reads refreshed_at off the first row, and a dead-SKU live lookup must not make the snapshot
  // look fresher than it is. Empty string when the snapshot is empty → the client leaves the
  // header's last (real) value untouched.
  const { data: snap } = await supabase.from('stock_snapshot').select('refreshed_at').limit(1).maybeSingle();
  const refreshed_at = (snap?.refreshed_at as string | null) ?? '';
  return [
    {
      item_code: row.item_code,
      name: cat ? cat.translate_name || cat.original_name || null : null,
      brand_prefix: cat?.brand_prefix ?? null,
      pending: row.pending,
      on_the_way: row.on_the_way,
      physical: row.physical,
      available: row.available,
      reserved: row.reserved,
      on_hold: row.on_hold,
      last_receive: row.last_receive,
      refreshed_at,
    },
  ];
}

// ── per-tab SKU counts (for the filter tabs). `all` = the active snapshot size; each state = SKUs
//    whose column is > 0. Head-only count queries (no rows transferred). ──
export async function getInventoryCounts(): Promise<InventoryCounts> {
  const supabase = createSupabaseServerClient();
  const countWhere = async (col?: 'pending' | 'on_the_way' | 'physical') => {
    let q = supabase.from('stock_snapshot').select('item_code', { count: 'exact', head: true });
    if (col) q = q.gt(col, 0);
    const { count } = await q;
    return count ?? 0;
  };
  const [all, on_order, shipping, warehouse] = await Promise.all([
    countWhere(),
    countWhere('pending'),
    countWhere('on_the_way'),
    countWhere('physical'),
  ]);
  return { all, on_order, shipping, warehouse };
}

// ── per-SKU stock ledger (PR172): every in/out movement with a running balance. Sources mirror the
//    stock_check view — inbound (not excluded), shipped order_lines, adjustments — so the final running
//    balance equals stock_check.physical. Opening-balance receipts are pinned first (they're dated
//    2023-12-31 but represent all pre-2024 receipts), then everything else in date order. ──
export async function getSkuLedger(itemCode: string): Promise<SkuLedger | null> {
  const supabase = createSupabaseServerClient();
  const code = itemCode.trim();
  if (!code) return null;

  const [{ data: sc }, { data: cat }, { data: inb }, { data: sold }, { data: adj }] = await Promise.all([
    supabase.from('stock_check').select('physical,available').eq('item_code', code).maybeSingle(),
    supabase.from('catalogue').select('translate_name,original_name,self_code').eq('item_code', code).maybeSingle(),
    supabase.from('inbound').select('qty,receive_date,ship_id,is_opening_balance,excluded').eq('item_code', code),
    supabase.from('order_lines').select('qty,shipped_at,sales_id').eq('item_code', code).not('shipped_at', 'is', null).eq('is_cancelled', false),
    supabase.from('adjustments').select('delta,created_at,source,note').eq('item_code', code),
  ]);

  const c = cat as { translate_name: string | null; original_name: string | null; self_code: string | null } | null;
  const name = c ? (c.translate_name || c.original_name || c.self_code || code) : code;

  // resolve a customer label per sale so a row reads "Sale — Name (last4)" instead of a bare order id
  const soldRows = (sold ?? []) as { qty: number; shipped_at: string | null; sales_id: string }[];
  const saleIds = [...new Set(soldRows.map((s) => s.sales_id))];
  const custBySale = new Map<string, string>();
  for (let i = 0; i < saleIds.length; i += 200) {
    const { data: ords } = await supabase
      .from('orders')
      .select('sales_id,customers(name,phone)')
      .in('sales_id', saleIds.slice(i, i + 200));
    for (const o of (ords ?? []) as { sales_id: string; customers: { name: string | null; phone: string | null } | { name: string | null; phone: string | null }[] | null }[]) {
      const cu = Array.isArray(o.customers) ? o.customers[0] : o.customers;
      if (cu) custBySale.set(o.sales_id, customerIdLabel(cu.name, cu.phone));
    }
  }

  type Raw = LedgerEntry & { pin: boolean };
  const raw: Raw[] = [];
  for (const r of (inb ?? []) as { qty: number; receive_date: string | null; ship_id: string | null; is_opening_balance: boolean; excluded: boolean }[]) {
    if (r.excluded) continue; // excluded (damaged) units never entered sellable stock
    const opening = r.is_opening_balance;
    raw.push({
      date: r.receive_date, kind: opening ? 'opening' : 'inbound', delta: r.qty, ref: r.ship_id,
      label: opening ? 'Opening balance (received through 2023)' : `Received${r.ship_id ? ` · ${r.ship_id}` : ''}`,
      balance: 0, pin: opening,
    });
  }
  for (const r of soldRows) {
    raw.push({ date: r.shipped_at, kind: 'sale', delta: -(r.qty || 0), ref: r.sales_id, label: `Sale — ${custBySale.get(r.sales_id) ?? r.sales_id}`, balance: 0, pin: false });
  }
  for (const r of (adj ?? []) as { delta: number; created_at: string | null; source: string | null; note: string | null }[]) {
    raw.push({ date: r.created_at, kind: 'adjustment', delta: r.delta || 0, ref: null, balance: 0, pin: false, label: `Adjustment${r.note ? ` — ${r.note}` : r.source ? ` (${r.source})` : ''}` });
  }

  // opening-balance receipts first (pinned), then oldest → newest by date
  raw.sort((a, b) => {
    if (a.pin !== b.pin) return a.pin ? -1 : 1;
    const da = a.date ?? '', db = b.date ?? '';
    return da < db ? -1 : da > db ? 1 : 0;
  });

  let bal = 0;
  const entries: LedgerEntry[] = raw.map(({ pin: _pin, ...e }) => { bal += e.delta; return { ...e, balance: bal }; });

  const stock = sc as { physical: number | null; available: number | null } | null;
  return { item_code: code, name, physical: stock?.physical ?? bal, available: stock?.available ?? bal, entries };
}

// ── History tab (PR176): the browsable A-Z list of SKUs that have movement, so the operator can open
//    any SKU's in/out ledger — including SKUs that were received and then fully sold (physical 0), which
//    the Browse snapshot excludes. "Moved" = received at least once (stock_check.last_receive not null);
//    a SKU with zero in has an empty ledger and is left out. Searchable by code or name, capped at LIMIT. ──
export async function getLedgerSkus(search?: string): Promise<LedgerSku[]> {
  const supabase = createSupabaseServerClient();
  const raw = search ? sanitize(search) : '';

  const codes = new Set<string>();

  // (1) code matches — or the full A-Z list when there's no search term
  let q = supabase
    .from('stock_check')
    .select('item_code,last_receive')
    .not('last_receive', 'is', null)
    .order('item_code', { ascending: true })
    .limit(LIMIT);
  if (raw) q = q.ilike('item_code', `%${raw}%`);
  const { data: byCode } = await q;
  for (const r of (byCode ?? []) as { item_code: string }[]) codes.add(r.item_code);

  // (2) name matches (search only): catalogue name/code ilike → keep only the ones that have moved
  if (raw) {
    const { data: cat } = await supabase
      .from('catalogue')
      .select('item_code')
      .or(`translate_name.ilike.%${raw}%,original_name.ilike.%${raw}%`)
      .limit(LIMIT);
    const nameCodes = (cat ?? []).map((c) => (c as { item_code: string }).item_code);
    if (nameCodes.length) {
      const { data: moved } = await supabase
        .from('stock_check')
        .select('item_code')
        .in('item_code', nameCodes)
        .not('last_receive', 'is', null)
        .limit(LIMIT);
      for (const r of (moved ?? []) as { item_code: string }[]) codes.add(r.item_code);
    }
  }

  const list = [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, LIMIT);
  if (!list.length) return [];

  // names (batched — the display label; falls back to the raw code)
  const nameByCode = new Map<string, string | null>();
  for (let i = 0; i < list.length; i += 500) {
    const { data } = await supabase
      .from('catalogue')
      .select('item_code,translate_name,original_name,self_code')
      .in('item_code', list.slice(i, i + 500));
    for (const c of (data ?? []) as { item_code: string; translate_name: string | null; original_name: string | null; self_code: string | null }[]) {
      nameByCode.set(c.item_code, c.translate_name || c.original_name || c.self_code || null);
    }
  }

  return list.map((item_code) => ({ item_code, name: nameByCode.get(item_code) ?? null }));
}

// ── recompute the snapshot now (the Refresh button) → the new "as of" timestamp ──
export async function refreshSnapshot(): Promise<{ refreshed_at: string | null }> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('refresh_stock_snapshot');
  if (error) throw new Error(`refreshSnapshot: ${error.message}`);
  const { data } = await supabase.from('stock_snapshot').select('refreshed_at').limit(1).maybeSingle();
  return { refreshed_at: (data?.refreshed_at as string | null) ?? null };
}
