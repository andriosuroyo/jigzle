'use server';

// Server actions for the History screen (PR-B §4) — a read-only, searchable view of ALL orders (the
// old "Sales: Data" sheet). Same auth posture as the other modules: the SSR supabase client (anon key
// + the signed-in user's session), so RLS (is_allowed_user()) gates every read. The summary panel +
// the one write (Mark paid) are reused from the Pending module (getOrderSummary / markOrderPaid).

import { createSupabaseServerClient } from '@jigzle/db/server';
import type { HistoryRow, HistoryState } from './types';

// Keep History light: load only the most recent orders by default. Search still queries the full
// orders table server-side (filtered), so older history is reachable on demand — just not shown up front.
const LIMIT = 100;

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

// ── searchable all-orders list (HI-1): match sales_id OR customer name OR order_date; newest first ──
export async function getHistory(query = ''): Promise<HistoryRow[]> {
  const supabase = createSupabaseServerClient();
  const raw = sanitize(query);

  let q = supabase
    .from('orders')
    .select('sales_id,order_date,status,payment_status,sales_total_idr,paid_idr,customer_id,customers(name),order_lines(line_id,fulfilled_at,shipped_at,is_cancelled)')
    .order('order_date', { ascending: false, nullsFirst: false })
    .limit(LIMIT);

  if (raw) {
    // a date-like query (YYYY, YYYY-MM, YYYY-MM-DD) filters order_date by [lower, upperExclusive);
    // otherwise match sales_id OR a customer whose name contains the query.
    const dateRange = isoRange(raw);
    if (dateRange) {
      q = q.gte('order_date', dateRange[0]).lt('order_date', dateRange[1]);
    } else {
      const { data: custs } = await supabase.from('customers').select('customer_id').ilike('name', `%${raw}%`).limit(500);
      const ids = ((custs ?? []) as { customer_id: number }[]).map((c) => c.customer_id);
      const ors = [`sales_id.ilike.%${raw}%`];
      if (ids.length) ors.push(`customer_id.in.(${ids.join(',')})`);
      q = q.or(ors.join(','));
    }
  }

  const { data, error } = await q;
  if (error || !data) return [];

  return data.map((o) => {
    const lines = (o.order_lines ?? []) as LineLite[];
    const active = lines.filter((l) => !l.is_cancelled);
    const cust = one<{ name: string | null }>(o.customers as never);
    const total = (o.sales_total_idr as number | null) ?? null;
    const paid = (o.paid_idr as number | null) ?? 0;
    return {
      sales_id: o.sales_id as string,
      customer_name: cust?.name ?? null,
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
