'use server';

// Server actions for the Fulfill module (Sales pipeline step 4). Same auth posture as the
// sales actions: the SSR supabase client (anon key + the signed-in user's session), so RLS
// (is_allowed_user()) gates every read and write. The service-role key is never used here.

import { createSupabaseServerClient } from '@jigzle/db/server';
import { customerIdLabel } from '@jigzle/lib';
import type { CustomerAddress } from '@jigzle/db/types';
import type {
  FulfillCutLine,
  FulfillDetail,
  SendToOutboundInput,
  ToSendQueueRow,
} from './types';

// Most-recent N 'Need send' orders with unfulfilled lines. The queue is timestamp-derived
// (D1), so there is no status to page on; cap the worklist and order by recency.
const QUEUE_LIMIT = 100;

// Embedded to-one resources come back as an object (or, depending on cardinality detection,
// a 1-element array). Normalize so callers can treat it as a single row or null.
function one<T>(v: T | T[] | null | undefined): T | null {
  if (v == null) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

function catName(c: { original_name: string | null; translate_name: string | null; self_code: string | null } | null): string | null {
  if (!c) return null;
  return c.translate_name || c.original_name || c.self_code || null;
}

// F4: a coded line with no catalogue name falls back to line_note → item_link host/slug → the literal
// "Unmatched item". NEVER the raw line_id.
// PR404: an UNCODED line (a custom item the catalogue doesn't carry yet, or a legacy import) carries its
// name in item_code_raw — that comes first, so such a line reads as itself, not "Unmatched item".
function fallbackName(rawCode: string | null, lineNote: string | null, itemLink: string | null): string {
  const raw = rawCode?.trim();
  if (raw) return raw;
  const note = lineNote?.trim();
  if (note) return note;
  const link = linkLabel(itemLink);
  if (link) return link;
  return 'Unmatched item';
}

function linkLabel(link: string | null): string | null {
  const s = link?.trim();
  if (!s) return null;
  try {
    const u = new URL(s.includes('://') ? s : `https://${s}`);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg ? `${u.hostname}/${seg}` : u.hostname;
  } catch {
    return s; // not a parseable URL — show the raw link text
  }
}

// ── the detail pane (FT-6: read-only cut lines + addresses; NO holds / availability / checkbox — the
// cut + hold-release already happened upstream; Fulfill only confirms address + courier) ──
export async function getOrderForFulfill(salesId: string): Promise<FulfillDetail | null> {
  const supabase = createSupabaseServerClient();

  const { data: order } = await supabase
    .from('orders')
    .select('sales_id,order_date,customer_id,address_id,export_courier,customers(name,phone)')
    .eq('sales_id', salesId)
    .maybeSingle();
  if (!order) return null;

  // the cut, not-yet-addressed (courier null), unshipped lines — the set Fulfill addresses + sends out
  const { data: lineRows } = await supabase
    .from('order_lines')
    .select('line_id,item_code,item_code_raw,qty,line_note,item_link,courier_tracking,catalogue(original_name,translate_name,self_code)')
    .eq('sales_id', salesId)
    .not('fulfilled_at', 'is', null)
    .is('courier', null)
    .is('shipped_at', null)
    .eq('is_cancelled', false)
    .order('line_id');

  // supabase-js types the to-one `catalogue` embed as an array; one() normalizes it at runtime.
  const rows = (lineRows ?? []) as unknown as {
    line_id: string;
    item_code: string | null;
    item_code_raw: string | null;
    qty: number;
    line_note: string | null;
    item_link: string | null;
    courier_tracking: string | null;
    catalogue: { original_name: string | null; translate_name: string | null; self_code: string | null } | null;
  }[];

  const lines: FulfillCutLine[] = rows.map((r) => ({
    line_id: r.line_id,
    item_code: r.item_code,
    // F4: catalogue name if matched, else item_code_raw → line_note → item_link → "Unmatched item" (never line_id)
    name: catName(one(r.catalogue as never)) || fallbackName(r.item_code_raw, r.line_note, r.item_link),
    qty: r.qty,
    line_note: r.line_note,
  }));

  const customerId = (order.customer_id as number | null) ?? null;
  let addresses: CustomerAddress[] = [];
  if (customerId != null) {
    const { data: addrs } = await supabase
      .from('customer_addresses')
      .select('*')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false });
    addresses = (addrs ?? []) as CustomerAddress[];
  }

  const cust = one<{ name: string | null; phone: string | null }>(order.customers as never);
  const addressId = (order.address_id as number | null) ?? null;
  // tracking survives a "Return to Fulfill" (kept on the line, courier cleared) → re-prefill it
  const courierTracking = rows.find((r) => r.courier_tracking)?.courier_tracking ?? null;
  return {
    sales_id: order.sales_id as string,
    order_date: (order.order_date as string | null) ?? null,
    customer_name: cust ? customerIdLabel(cust.name, cust.phone) : null,
    customer_phone: cust?.phone ?? null,
    default_address_id: addressId,
    needs_address: addressId == null,
    courier_tracking: courierTracking,
    export_courier: (order.export_courier as string | null) ?? null,
    lines,
    addresses,
  };
}

// (Stage 7) The legacy fulfillOrder action — which called the fulfill_order RPC to cut + courier in
// one step — is retired: the cut now happens upstream (cut_order_lines at New/Pending) and the courier
// at sendToOutbound (set_fulfillment). The fulfill_order DB function is LEFT in place, dormant.

// ── PR-B "To send" queue (FT-2/FT-3): orders with cut + courier-null + unshipped lines. The !inner
// embed + embedded filters restrict both which orders return AND which lines come back (only the cut,
// not-yet-addressed lines — a partial order's already-shipped or still-uncut lines are elsewhere). ──
export async function getToSendQueue(): Promise<ToSendQueueRow[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('orders')
    .select('sales_id,order_date,customer_id,payment_status,customers(name,phone),order_lines!inner(line_id,item_code)')
    .not('order_lines.fulfilled_at', 'is', null)
    .is('order_lines.courier', null)
    .is('order_lines.shipped_at', null)
    .eq('order_lines.is_cancelled', false)
    .order('order_date', { ascending: false, nullsFirst: false })
    .limit(QUEUE_LIMIT);
  if (error || !data) return [];

  return data.map((o) => {
    const lines = (o.order_lines ?? []) as { line_id: string; item_code: string | null }[];
    const cust = one<{ name: string | null; phone: string | null }>(o.customers as never);
    return {
      sales_id: o.sales_id as string,
      order_date: (o.order_date as string | null) ?? null,
      customer_name: cust ? customerIdLabel(cust.name, cust.phone) : null,
      payment_status: (o.payment_status as string | null) ?? null,
      item_count: lines.length,
      sku_codes: lines.map((l) => l.item_code).filter((c): c is string => !!c),
    };
  });
}

// PR145: button-handler actions RETURN their error as data ({ error }) instead of throwing —
// Next.js redacts thrown Error messages in production ("An error occurred in the Server Components
// render…"), which turned a simple "a courier is required" into an opaque banner. Returning the
// message keeps it readable in production. Follow this pattern for every action a button awaits.

// ── Send to Outbound (FT-6): set courier + (deferred) address on the cut lines via set_fulfillment
// (PR-A). No stock movement. Server-validates the Outbound gate: address + courier both present. ──
export async function sendToOutbound(input: SendToOutboundInput): Promise<{ error: string | null }> {
  if (!input.line_ids?.length) return { error: 'sendToOutbound: no cut lines to send' };
  if (!input.address_id) return { error: 'sendToOutbound: an address is required' };
  if (!input.courier) return { error: 'sendToOutbound: a courier is required — check the courier row in Settings → Shipping' };
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('set_fulfillment', {
    p_sales_id: input.sales_id,
    p_line_ids: input.line_ids,
    p_address_id: input.address_id,
    p_courier: input.courier,
    p_tracking: input.tracking ?? null,
    p_courier_speed: input.courier_speed ?? null,
    p_courier_label: input.courier_label ?? null,
  });
  if (error) return { error: `sendToOutbound: ${error.message}` };
  // PR192: stamp the export courier onto the order (kept in sync with the ship-to — null for a
  // domestic address). Separate from set_fulfillment so the RPC is untouched; same order, RLS-gated.
  const { error: xErr } = await supabase
    .from('orders')
    .update({ export_courier: input.export_courier ?? null })
    .eq('sales_id', input.sales_id);
  return { error: xErr ? `sendToOutbound: shipped, but couldn't record export courier: ${xErr.message}` : null };
}

// ── Send back to pending (FT-4): clear the cut entirely (unfulfill_order) → the lines return to
// Pending uncut, stock restored. Inverse of the cut; holds + payment untouched. ──
export async function sendBackToPending(salesId: string): Promise<{ error: string | null }> {
  if (!salesId) return { error: 'sendBackToPending: sales_id is required' };
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.rpc('unfulfill_order', { p_sales_id: salesId });
  return { error: error ? `sendBackToPending: ${error.message}` : null };
}
