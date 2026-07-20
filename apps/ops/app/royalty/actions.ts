'use server';

// Clover Royalty (PR392). Server actions for the Royalty screen + its Settings sub-editor. Same auth
// posture as the rest of the app: SSR supabase client, RLS via is_allowed_user(); no service-role key.
//
// Model: royalty_entities (managed list) · royalty_rate_rows (per-entity piece-count → Rp schedule) ·
// royalty_paid (the existing ledger, 0008). A royalty is OWED for a Clover SKU (catalogue.artist = an
// entity) once its order line is PAID (orders.payment_status='Paid') AND SENT (order_lines.shipped_at
// not null, not cancelled) — exactly the "sold = paid + sent" rule. syncRoyalties() accrues those lines
// into royalty_paid and keeps UNPAID amounts in step with the current schedule (paid rows are history —
// never touched). Mutations return errors as data (never throw) since button handlers await them.

import { createSupabaseServerClient } from '@jigzle/db/server';
import type { RoyaltyEntity, RoyaltyRateRow, RoyaltyLedger, RoyaltyLine } from './types';

const dateOf = (ts: string | null): string | null => (ts ? ts.slice(0, 10) : null);

// ── entities ──────────────────────────────────────────────────────────────
export async function getRoyaltyEntities(): Promise<RoyaltyEntity[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('royalty_entities')
    .select('id,name,is_active,sort_order')
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  if (error) return []; // table not applied yet → degrade
  return (data ?? []) as RoyaltyEntity[];
}

export async function addRoyaltyEntity(name: string): Promise<{ row: RoyaltyEntity | null; error: string | null }> {
  const nm = name.trim();
  if (!nm) return { row: null, error: 'A name is required.' };
  const supabase = createSupabaseServerClient();
  const dup = await supabase.from('royalty_entities').select('id').ilike('name', nm).maybeSingle();
  if (dup.data) return { row: null, error: `"${nm}" already exists.` };
  const { data: top } = await supabase.from('royalty_entities').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle();
  const sort_order = ((top?.sort_order as number | null) ?? -1) + 1;
  const { data, error } = await supabase.from('royalty_entities').insert({ name: nm, sort_order }).select('id,name,is_active,sort_order').single();
  if (error) return { row: null, error: error.message };
  return { row: data as RoyaltyEntity, error: null };
}

// Rename cascades everywhere the entity name is a key: its rate rows, the ledger's partner, and the
// SKUs' artist tag — so the artist→entity link and the schedule stay intact.
export async function renameRoyaltyEntity(id: number, oldName: string, newName: string): Promise<{ error: string | null }> {
  const nm = newName.trim();
  if (!nm) return { error: 'A name is required.' };
  if (nm === oldName) return { error: null };
  const supabase = createSupabaseServerClient();
  const dup = await supabase.from('royalty_entities').select('id').ilike('name', nm).neq('id', id).maybeSingle();
  if (dup.data) return { error: `"${nm}" already exists.` };
  const { error } = await supabase.from('royalty_entities').update({ name: nm }).eq('id', id);
  if (error) return { error: error.message };
  await supabase.from('royalty_rate_rows').update({ entity: nm }).eq('entity', oldName);
  await supabase.from('royalty_paid').update({ partner: nm }).eq('partner', oldName);
  await supabase.from('catalogue').update({ artist: nm }).eq('artist', oldName);
  return { error: null };
}

// Delete is blocked while the entity still has ledger history — protects the paid/unpaid record.
export async function deleteRoyaltyEntity(id: number, name: string): Promise<{ error: string | null }> {
  const supabase = createSupabaseServerClient();
  const { count } = await supabase.from('royalty_paid').select('id', { count: 'exact', head: true }).eq('partner', name);
  if ((count ?? 0) > 0) return { error: `"${name}" has ${count} royalty record${count === 1 ? '' : 's'} — it can't be deleted.` };
  await supabase.from('royalty_rate_rows').delete().eq('entity', name);
  const { error } = await supabase.from('royalty_entities').delete().eq('id', id);
  if (error) return { error: error.message };
  return { error: null };
}

// ── rate schedule ─────────────────────────────────────────────────────────
export async function getRoyaltyRates(entity: string): Promise<RoyaltyRateRow[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from('royalty_rate_rows')
    .select('id,entity,pieces,royalty_idr')
    .eq('entity', entity)
    .order('pieces', { ascending: true });
  if (error) return [];
  return (data ?? []) as RoyaltyRateRow[];
}

export async function upsertRoyaltyRate(entity: string, pieces: number, royaltyIdr: number): Promise<{ error: string | null }> {
  if (!entity) return { error: 'An entity is required.' };
  if (!Number.isFinite(pieces) || pieces <= 0) return { error: 'Piece count must be a positive number.' };
  if (!Number.isFinite(royaltyIdr) || royaltyIdr < 0) return { error: 'Royalty must be zero or more.' };
  const supabase = createSupabaseServerClient();
  const { error } = await supabase
    .from('royalty_rate_rows')
    .upsert({ entity, pieces: Math.round(pieces), royalty_idr: Math.round(royaltyIdr) }, { onConflict: 'entity,pieces' });
  if (error) return { error: error.message };
  return { error: null };
}

export async function deleteRoyaltyRate(id: number): Promise<{ error: string | null }> {
  const supabase = createSupabaseServerClient();
  const { error } = await supabase.from('royalty_rate_rows').delete().eq('id', id);
  if (error) return { error: error.message };
  return { error: null };
}

// ── the Royalty screen: accrue, then read the ledger + totals for one entity ────────────────────────
type CatNameRow = { item_code: string; translate_name: string | null; original_name: string | null; self_code: string | null };
const nameOf = (c: CatNameRow): string => c.translate_name || c.original_name || c.self_code || c.item_code;

async function usdRate(supabase: ReturnType<typeof createSupabaseServerClient>): Promise<number | null> {
  const { data } = await supabase.from('currencies').select('rate_to_idr').eq('code', 'USD').maybeSingle();
  const r = data ? Number((data as { rate_to_idr: number }).rate_to_idr) : 0;
  return r > 0 ? r : null;
}

// Accrue every PAID+SENT Clover line into royalty_paid, and reconcile UNPAID amounts to the current
// schedule. Paid rows are history and are never modified. Returns the number of NEW rows inserted.
export async function syncRoyalties(): Promise<number> {
  const supabase = createSupabaseServerClient();

  const ents = await getRoyaltyEntities();
  const names = ents.map((e) => e.name);
  if (!names.length) return 0;

  // Clover SKUs by these entities → item_code → { entity, pieces }
  // A royalty is owed only for OUR OWN brand (Clover = prefix 'CLO') by one of the entities' artists —
  // an entity name appearing as an artist on some other brand's SKU never accrues.
  const { data: cat } = await supabase.from('catalogue').select('item_code,artist,piece_count_n').in('artist', names).eq('brand_prefix', 'CLO');
  const skuInfo = new Map<string, { entity: string; pieces: number | null }>();
  for (const r of (cat ?? []) as { item_code: string; artist: string | null; piece_count_n: number | null }[]) {
    if (r.artist) skuInfo.set(r.item_code, { entity: r.artist, pieces: r.piece_count_n });
  }
  if (!skuInfo.size) return 0;
  const codes = [...skuInfo.keys()];

  // qualifying lines: shipped (sent) + not cancelled + item is one of ours
  const lines: { line_id: string; item_code: string; qty: number; shipped_at: string | null; sales_id: string }[] = [];
  const CHUNK = 200;
  for (let i = 0; i < codes.length; i += CHUNK) {
    const { data } = await supabase
      .from('order_lines')
      .select('line_id,item_code,qty,shipped_at,sales_id')
      .in('item_code', codes.slice(i, i + CHUNK))
      .not('shipped_at', 'is', null)
      .eq('is_cancelled', false);
    for (const l of (data ?? []) as typeof lines) lines.push(l);
  }
  if (!lines.length) return 0;

  // keep only lines whose ORDER is fully paid
  const salesIds = [...new Set(lines.map((l) => l.sales_id))];
  const paidOrders = new Set<string>();
  for (let i = 0; i < salesIds.length; i += CHUNK) {
    const { data } = await supabase.from('orders').select('sales_id,payment_status').in('sales_id', salesIds.slice(i, i + CHUNK)).eq('payment_status', 'Paid');
    for (const o of (data ?? []) as { sales_id: string }[]) paidOrders.add(o.sales_id);
  }

  // current rate schedule → rate[entity][pieces]
  const { data: rateData } = await supabase.from('royalty_rate_rows').select('entity,pieces,royalty_idr');
  const rate = new Map<string, number>();
  for (const r of (rateData ?? []) as { entity: string; pieces: number; royalty_idr: number }[]) rate.set(`${r.entity}|${r.pieces}`, r.royalty_idr);

  // existing ledger rows (line_id → {id, paid, royalty_idr})
  const { data: existing } = await supabase.from('royalty_paid').select('id,line_id,paid_date,royalty_idr');
  const byLine = new Map<string, { id: number; paid: boolean; royalty_idr: number }>();
  for (const r of (existing ?? []) as { id: number; line_id: string; paid_date: string | null; royalty_idr: number }[]) {
    byLine.set(r.line_id, { id: r.id, paid: !!r.paid_date, royalty_idr: r.royalty_idr });
  }

  // Accrue new qualifying lines, and keep UNPAID amounts on the current schedule. PAID rows are FROZEN
  // (never touched), so a later rate change (e.g. 1000p Rp 150k -> 160k) never rewrites history — it
  // only moves what is still owed. An unpaid line's amount = current per-unit rate x qty.
  const inserts: Record<string, unknown>[] = [];
  const reconcile: { id: number; royalty_idr: number }[] = [];
  for (const l of lines) {
    if (!paidOrders.has(l.sales_id)) continue;
    const info = skuInfo.get(l.item_code);
    if (!info) continue;
    const lineTotal = ((info.pieces != null ? rate.get(`${info.entity}|${info.pieces}`) : undefined) ?? 0) * (l.qty ?? 1);
    const cur = byLine.get(l.line_id);
    if (!cur) {
      inserts.push({
        line_id: l.line_id, partner: info.entity, item_code: l.item_code, qty: l.qty ?? 1,
        royalty_idr: lineTotal, fulfill_date: dateOf(l.shipped_at), paid_date: null,
      });
    } else if (!cur.paid && cur.royalty_idr !== lineTotal) {
      reconcile.push({ id: cur.id, royalty_idr: lineTotal }); // unpaid tracks current rate; paid frozen
    }
  }

  for (let i = 0; i < inserts.length; i += 200) {
    await supabase.from('royalty_paid').insert(inserts.slice(i, i + 200));
  }
  await Promise.all(reconcile.map((r) => supabase.from('royalty_paid').update({ royalty_idr: r.royalty_idr }).eq('id', r.id)));
  return inserts.length;
}

export async function getRoyaltyLedger(entity: string): Promise<RoyaltyLedger> {
  const supabase = createSupabaseServerClient();
  const synced = await syncRoyalties().catch(() => 0);

  const { data: rows } = await supabase
    .from('royalty_paid')
    .select('line_id,item_code,qty,royalty_idr,paid_date,fulfill_date')
    .eq('partner', entity);
  const ledger = (rows ?? []) as { line_id: string; item_code: string | null; qty: number; royalty_idr: number; paid_date: string | null; fulfill_date: string | null }[];

  // names (catalogue) + true sold date (order_lines.shipped_at)
  const codes = [...new Set(ledger.map((r) => r.item_code).filter(Boolean) as string[])];
  const names = new Map<string, string>();
  for (let i = 0; i < codes.length; i += 200) {
    const { data } = await supabase.from('catalogue').select('item_code,translate_name,original_name,self_code').in('item_code', codes.slice(i, i + 200));
    for (const c of (data ?? []) as CatNameRow[]) names.set(c.item_code, nameOf(c));
  }
  const lineIds = [...new Set(ledger.map((r) => r.line_id).filter(Boolean))];
  const shipped = new Map<string, string | null>();
  for (let i = 0; i < lineIds.length; i += 200) {
    const { data } = await supabase.from('order_lines').select('line_id,shipped_at').in('line_id', lineIds.slice(i, i + 200));
    for (const l of (data ?? []) as { line_id: string; shipped_at: string | null }[]) shipped.set(l.line_id, dateOf(l.shipped_at));
  }

  const lines: RoyaltyLine[] = ledger.map((r) => ({
    line_id: r.line_id,
    item_code: r.item_code,
    name: r.item_code ? (names.get(r.item_code) ?? r.item_code) : '—',
    sold_date: shipped.get(r.line_id) ?? r.fulfill_date ?? null,
    paid_date: r.paid_date ?? null,
    qty: r.qty ?? 1,
    royalty_idr: r.royalty_idr ?? 0,
    paid: !!r.paid_date,
  }));
  // newest sold first; undated last
  lines.sort((a, b) => (b.sold_date ?? '').localeCompare(a.sold_date ?? ''));

  const unpaid_idr = lines.filter((l) => !l.paid).reduce((s, l) => s + l.royalty_idr, 0);
  const paid_idr = lines.filter((l) => l.paid).reduce((s, l) => s + l.royalty_idr, 0);
  const rate = await usdRate(supabase);
  return {
    lines,
    unpaid_idr,
    paid_idr,
    usd_rate: rate,
    unpaid_usd: rate ? unpaid_idr / rate : null,
    synced,
  };
}

// Mark a set of ledger lines paid (stamp today) or unpaid (clear). Error-as-data.
export async function setRoyaltyPaid(lineIds: string[], paid: boolean): Promise<{ error: string | null }> {
  const ids = lineIds.filter(Boolean);
  if (!ids.length) return { error: null };
  const supabase = createSupabaseServerClient();
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from('royalty_paid').update({ paid_date: paid ? today : null }).in('line_id', ids);
  if (error) return { error: error.message };
  return { error: null };
}
