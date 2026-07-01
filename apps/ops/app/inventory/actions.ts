'use server';

// Server actions for the Inventory (Stock Check) screen — READ-ONLY. Same auth posture as the
// other modules: the SSR supabase client (anon key + the signed-in user's session), so RLS
// (is_allowed_user()) gates the live stock_check fallback; the matview is granted to authenticated.
// The service-role key is never used here. No stock-mutating writes live on this screen.

import { createSupabaseServerClient } from '@jigzle/db/server';
import type { InventoryCounts, InventoryFilter, InventorySortColumn, StockRow } from '@jigzle/db/types';

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

// ── recompute the snapshot now (the Refresh button) → the new "as of" timestamp ──
export async function refreshSnapshot(): Promise<{ refreshed_at: string | null }> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('refresh_stock_snapshot');
  if (error) throw new Error(`refreshSnapshot: ${error.message}`);
  const { data } = await supabase.from('stock_snapshot').select('refreshed_at').limit(1).maybeSingle();
  return { refreshed_at: (data?.refreshed_at as string | null) ?? null };
}
