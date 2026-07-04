'use server';

// Server actions for the History screen (PR-B §4) — a read-only, searchable view of ALL orders (the
// old "Sales: Data" sheet). Same auth posture as the other modules: the SSR supabase client (anon key
// + the signed-in user's session), so RLS (is_allowed_user()) gates every read. The summary panel +
// the one write (Mark paid) are reused from the Pending module (getOrderSummary / markOrderPaid).

import { createSupabaseServerClient } from '@jigzle/db/server';
import { customerIdLabel } from '@jigzle/lib';
import type { HistoryRow, HistoryState } from './types';

// PR164 — History shows the FULL terminal-order log (the client buckets it into year sub-tabs), so the
// loader pages through everything instead of capping. PostgREST caps a single response at 1000 rows
// regardless of .limit(), so we page in 1000-row batches (stable order: order_date, then sales_id) up
// to HISTORY_SCAN.
const PAGE = 1000;
const HISTORY_SCAN = 40000; // orders scanned (1 row per order) — a safety backstop well above real volume

function one<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

type LineLite = { fulfilled_at: string | null; shipped_at: string | null; is_cancelled: boolean };

// same lifecycle derivation as the Pending/PR27 board (status + line progress). Cancelled is its own
// terminal state here (History shows everything, including cancelled orders).
function deriveState(status: string | null, lines: LineLite[]): HistoryState {
  if (status === 'Cancelled') return 'cancelled';
  if (status === 'Need payment') return 'need_payment';
  if (status === 'Complete') return 'complete';
  const active = lines.filter((l) => !l.is_cancelled);
  if (active.some((l) => l.fulfilled_at && !l.shipped_at)) return 'ready_to_ship';
  return 'need_send';
}

// PostgREST .or()/.ilike() interpolate into a filter grammar — strip operator chars from user input.
function sanitize(q: string): string {
  return q.replace(/[,()*\\]/g, ' ').trim();
}

// Add / edit the free-text note on an order (History annotation). Writes orders.order_note directly —
// RLS (orders_all: is_allowed_user) gates it; empty input clears the note. Returns the saved value.
export async function setOrderNote(salesId: string, note: string): Promise<string | null> {
  const supabase = createSupabaseServerClient();
  const value = note.trim() || null;
  const { error } = await supabase.from('orders').update({ order_note: value }).eq('sales_id', salesId);
  if (error) throw new Error(error.message);
  return value;
}

// ── searchable finished-orders list (HI-1, narrowed PR149): History = TERMINAL orders only
// (Complete + Cancelled). In-flight orders live in Pending/Fulfill — listing them here too read as
// noise ("NEED SEND" rows the operator expected to be green). Match sales_id OR customer name OR
// order_date; newest first. ──
export async function getHistory(query = ''): Promise<HistoryRow[]> {
  const supabase = createSupabaseServerClient();
  const raw = sanitize(query);

  // Resolve the search filter ONCE (a date range, or the OR-clauses for id / customer / SKU), then apply
  // it to every page below. Empty query → no filter, so History returns the whole terminal-order log.
  let dateRange: [string, string] | null = null;
  let orClauses: string[] | null = null;
  if (raw) {
    // a date-like query (YYYY, YYYY-MM, YYYY-MM-DD) filters order_date by [lower, upperExclusive);
    // otherwise match sales_id OR a customer whose name contains the query.
    dateRange = isoRange(raw);
    if (!dateRange) {
      // Non-date query → match order id OR a customer name OR an item SKU on any of the order's lines
      // (PR161: SKU search — the order_lines.item_code index makes the contains-lookup cheap).
      const [{ data: custs }, { data: lineRows }] = await Promise.all([
        supabase.from('customers').select('customer_id').ilike('name', `%${raw}%`).limit(500),
        supabase.from('order_lines').select('sales_id').ilike('item_code', `%${raw}%`).limit(1000),
      ]);
      const ids = ((custs ?? []) as { customer_id: number }[]).map((c) => c.customer_id);
      const salesIds = Array.from(new Set(((lineRows ?? []) as { sales_id: string }[]).map((r) => r.sales_id)));
      orClauses = [`sales_id.ilike.%${raw}%`];
      if (ids.length) orClauses.push(`customer_id.in.(${ids.join(',')})`);
      if (salesIds.length) orClauses.push(`sales_id.in.(${salesIds.map((s) => `"${s}"`).join(',')})`);
    }
  }

  // Page through the full result set (PostgREST caps a response at 1000 rows). Stable order —
  // order_date desc then sales_id desc — so paging never drops or repeats a row.
  type OrderRow = Record<string, unknown> & { order_lines?: LineLite[]; customers?: unknown; order_date?: string | null };
  const data: OrderRow[] = [];
  for (let from = 0; from < HISTORY_SCAN; from += PAGE) {
    let q = supabase
      .from('orders')
      .select('sales_id,order_date,status,payment_status,sales_total_idr,paid_idr,customer_id,customers(name,phone),order_lines(line_id,fulfilled_at,shipped_at,is_cancelled)')
      .in('status', ['Complete', 'Cancelled'])
      .order('order_date', { ascending: false, nullsFirst: false })
      .order('sales_id', { ascending: false })
      .range(from, from + PAGE - 1);
    if (dateRange) q = q.gte('order_date', dateRange[0]).lt('order_date', dateRange[1]);
    else if (orClauses) q = q.or(orClauses.join(','));
    const { data: page, error } = await q;
    if (error || !page) break;
    data.push(...(page as OrderRow[]));
    if (page.length < PAGE) break;
  }

  return data.map((o) => {
    const lines = (o.order_lines ?? []) as LineLite[];
    const active = lines.filter((l) => !l.is_cancelled);
    const cust = one<{ name: string | null; phone: string | null }>(o.customers as never);
    const total = (o.sales_total_idr as number | null) ?? null;
    const paid = (o.paid_idr as number | null) ?? 0;
    return {
      sales_id: o.sales_id as string,
      customer_name: cust ? customerIdLabel(cust.name, cust.phone) : null,
      order_date: (o.order_date as string | null) ?? null,
      status: (o.status as string | null) ?? null,
      payment_status: (o.payment_status as string | null) ?? null,
      sales_total_idr: total,
      paid_idr: paid,
      balance: Math.max((total ?? 0) - paid, 0),
      item_count: active.length,
      state: deriveState(o.status as string | null, lines),
    };
  });
}

// Parse a YYYY / YYYY-MM / YYYY-MM-DD prefix into [start, endExclusive] ISO dates; null if not date-like.
function isoRange(s: string): [string, string] | null {
  const m = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : null;
  const d = m[3] ? Number(m[3]) : null;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (mo == null) return [`${y}-01-01`, `${y + 1}-01-01`];
  if (mo < 1 || mo > 12) return null;
  if (d == null) {
    const ny = mo === 12 ? y + 1 : y;
    const nm = mo === 12 ? 1 : mo + 1;
    return [`${y}-${pad(mo)}-01`, `${ny}-${pad(nm)}-01`];
  }
  if (d < 1 || d > 31) return null;
  const start = `${y}-${pad(mo)}-${pad(d)}`;
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const end = `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
  return [start, end];
}
