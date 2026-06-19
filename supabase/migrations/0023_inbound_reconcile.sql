-- PR17 — Inbound ↔ Order reconciliation (docs/PR17-inbound-reconcile-spec.md, v1.1 redlined).
-- Reworks receiving into QTY/LINE-AWARE reconciliation with short-revert, plus a reversible
-- receipt unit. No change to the stock_check view, the importer, next_adhoc_ship_id, or other RPCs.
--
--   a. receipts             — one reversible unit per confirmed receive: what it closed + the PO
--                             change-log (prior values) so reverse_receipt can fully undo it.
--   b. inbound.receipt_id   — links the inbound rows a receipt added (for reverse + audit).
--   c. inbound.excluded_qty — informational count of arrived-but-damaged units on a row whose
--                             qty already = sellable (counted − excluded). NOT summed into stock.
--   d. adjustments.source   — CHECK extended with 'reverse' (redline CHANGE 1) so a reverse's
--                             compensating ledger entry filters cleanly vs genuine manual ones.
--   e. record_receipt()     — REWORKED to the §4 algorithm (return type text[] → jsonb).
--   f. reverse_receipt()    — mis-count recovery: compensating adjustment + PO restore + un-close.
--
-- Security posture follows the house style (0015/0022): every write RPC is SECURITY INVOKER with a
-- pinned search_path, so RLS (is_allowed_user(), 0017) gates every read/write under the signed-in
-- user; service_role (the smoke harness) may also call them. Validate-before-write: a rejected
-- reconcile leaves ZERO residue (the whole function is one transaction). Same-ship_id receives are
-- serialized by a per-ship advisory lock (same posture as next_adhoc_ship_id's allocator lock).

-- ============================================================================
-- 1. receipts (reversible unit) + inbound link/exclude columns
-- ============================================================================

create table if not exists public.receipts (
  receipt_id                   bigint generated always as identity primary key,
  ship_id                      text,                                 -- the receive target (real or 📦/ad-hoc)
  receive_date                 date not null,
  is_shipment                  boolean not null default false,       -- ship_id is a real shipments row
  closed                       boolean not null default false,       -- this receipt closed the shipment
  prior_shipment_status        text,                                 -- shipments.status before close (for un-close)
  prior_shipment_received_date date,                                 -- shipments.received_date before close
  po_changes                   jsonb not null default '[]'::jsonb,   -- [{po_id, change_type, is_new_row, prior_*}]
  status                       text not null default 'active' check (status in ('active', 'reversed')),
  reversed_at                  timestamptz,
  reversed_by                  text,
  reverse_note                 text,
  created_by                   text,
  created_at                   timestamptz not null default now()
);
create index if not exists receipts_ship_id_idx on public.receipts (ship_id);
create index if not exists receipts_status_idx  on public.receipts (status);

-- link each inbound row to the receipt that created it (NEW app receipts only; legacy rows stay NULL).
alter table public.inbound add column if not exists receipt_id bigint
  references public.receipts(receipt_id) on delete set null;
-- arrived-but-not-sellable count on a row whose qty is ALREADY net sellable. Informational: the
-- stock_check view sums qty (sellable), never excluded_qty.
alter table public.inbound add column if not exists excluded_qty integer not null default 0;
create index if not exists inbound_receipt_idx on public.inbound (receipt_id);

-- redline CHANGE 1: tag reverse compensations distinctly from genuine manual adjustments.
alter table public.adjustments drop constraint if exists adjustments_source_check;
alter table public.adjustments add constraint adjustments_source_check
  check (source in ('stock_check', 'manual', 'reverse'));

-- ============================================================================
-- 2. RLS + grants (house pattern: one "<table>_all" policy gated by is_allowed_user())
-- ============================================================================

alter table public.receipts enable row level security;
drop policy if exists "receipts_all" on public.receipts;
create policy "receipts_all" on public.receipts
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

revoke all on public.receipts from anon;
grant select, insert, update, delete on public.receipts to authenticated, service_role;

-- ============================================================================
-- 3. record_receipt() — reworked to the §4 reconciliation algorithm
--    Return type changes text[] → jsonb {receipt_id, affected, closed}; the arg signature is
--    unchanged, so DROP first, then re-grant identically to 0015.
-- ============================================================================

drop function if exists public.record_receipt(text, date, jsonb, boolean);

create or replace function public.record_receipt(
  p_ship_id        text,
  p_receive_date   date,
  p_lines          jsonb,
  p_close_shipment boolean
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tracking    text;
  v_is_ship     boolean;
  v_ship_status text;
  v_ship_recv   date;
  v_missing     text[];
  v_receipt_id  bigint;
  v_changes     jsonb := '[]'::jsonb;
  v_new_pos     bigint[] := '{}';
  v_codes       text[];
  v_close       boolean := coalesce(p_close_shipment, false);
  v_crumb       text;
  v_new_po      bigint;
  v_remaining   int;
  rec           record;
  poline        record;
begin
  -- ── 0. VALIDATE-BEFORE-WRITE (zero residue on reject + friendly errors) ──
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1 then
    raise exception 'record_receipt: at least one receive line is required';
  end if;

  -- every line MUST resolve to an existing catalogue SKU (fail loud, same guard as 0015).
  select array_agg(distinct code) into v_missing
  from (
    select coalesce(nullif(l->>'item_code', ''), '(blank)') as code
    from jsonb_array_elements(p_lines) as l
  ) s
  where not exists (select 1 from catalogue c where c.item_code = s.code);
  if v_missing is not null then
    raise exception 'record_receipt: unknown/blank item_code(s): %', array_to_string(v_missing, ', ');
  end if;

  -- every line: an integer qty; any provided label within the inbound CHECK enum.
  if exists (
    select 1 from jsonb_array_elements(p_lines) l
    where l->>'qty' is null or (l->>'qty') !~ '^-?[0-9]+$'
  ) then
    raise exception 'record_receipt: every line needs an integer qty';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) l
    where nullif(l->>'label', '') is not null
      and l->>'label' not in ('Exclude', 'Hold', 'Tokopedia')
  ) then
    raise exception 'record_receipt: label must be Exclude, Hold or Tokopedia';
  end if;
  -- a provided excluded_qty must be an integer (else the cast below trips an opaque error).
  if exists (
    select 1 from jsonb_array_elements(p_lines) l
    where nullif(l->>'excluded_qty', '') is not null and (l->>'excluded_qty') !~ '^-?[0-9]+$'
  ) then
    raise exception 'record_receipt: excluded_qty must be an integer';
  end if;

  -- per-SKU: 0 <= excluded <= counted (never insert a NEGATIVE sellable row from bad input).
  if exists (
    select 1 from (
      select sum((l->>'qty')::int) as counted,
             sum(coalesce((l->>'excluded_qty')::int,
                          case when coalesce((l->>'excluded')::boolean, false)
                               then greatest((l->>'qty')::int, 0) else 0 end)) as excl
      from jsonb_array_elements(p_lines) l
      group by l->>'item_code'
    ) g
    where g.excl < 0 or g.excl > greatest(g.counted, 0)
  ) then
    raise exception 'record_receipt: excluded qty must be between 0 and the counted qty';
  end if;

  -- ── 1. concurrency guard: serialize receives/reverses of the SAME ship_id ──
  perform pg_advisory_xact_lock(hashtext('jz_receive_ship'), hashtext(coalesce(p_ship_id, '')));

  -- A real ship_id lends tracking; an ad-hoc 📦/free-text id matches no shipment (tracking NULL).
  select tracking, status, received_date into v_tracking, v_ship_status, v_ship_recv
    from shipments where ship_id = p_ship_id;
  v_is_ship := found;
  if v_is_ship and v_ship_status = 'completed' then
    raise exception 'record_receipt: shipment % is already completed', p_ship_id;
  end if;

  -- ── 2. open the receipt header (reversible unit) ──
  insert into receipts (ship_id, receive_date, is_shipment, closed,
                        prior_shipment_status, prior_shipment_received_date, created_by)
  values (p_ship_id, p_receive_date, v_is_ship, (v_close and v_is_ship),
          v_ship_status, v_ship_recv, lower(auth.jwt() ->> 'email'))
  returning receipt_id into v_receipt_id;

  -- ── 3. per SKU: enter arrivals (ONE row, qty = sellable, excluded_qty informational),
  --       then allocate TOTAL arrived against open PO lines oldest-first ──
  for rec in
    select l->>'item_code' as item_code,
           sum((l->>'qty')::int) as counted,
           sum(coalesce((l->>'excluded_qty')::int,
                        case when coalesce((l->>'excluded')::boolean, false)
                             then greatest((l->>'qty')::int, 0) else 0 end)) as excluded_qty,
           max(nullif(l->>'exclude_reason', ''))   as reason,
           max(nullif(l->>'label', ''))            as label,
           max(nullif(l->>'dimension_weight', '')) as dim
    from jsonb_array_elements(p_lines) l
    group by l->>'item_code'
  loop
    -- (a) ONE inbound row per SKU. qty = counted − excluded (the sellable amount, feeds the shelf);
    --     excluded_qty records the damaged/non-sellable count; the reason rides receive_note.
    --     ALWAYS write the row (even fully-excluded → qty 0) so every arrived unit is recorded.
    if rec.counted <> 0 or rec.excluded_qty > 0 then
      insert into inbound (item_code, qty, ship_id, receive_date, excluded, excluded_qty,
                           label, receive_note, dimension_weight, tracking, receipt_id)
      values (rec.item_code, rec.counted - rec.excluded_qty, p_ship_id, p_receive_date,
              false, rec.excluded_qty, rec.label,
              case when rec.excluded_qty > 0 then rec.reason else null end,
              rec.dim, v_tracking, v_receipt_id);
    end if;

    -- (b) allocate TOTAL arrived (counted incl. excluded; a unit that arrived fulfils the order
    --     even if damaged) against this ship_id's open PO lines, oldest first.
    v_remaining := greatest(rec.counted, 0);
    if v_remaining > 0 then
      for poline in
        select po_id, qty, status, status_since, ship_id, receive_date, shipment_note,
               encrypt, supplier_id, item_code, customer_id, marketplace_order_id, item_cost, input_date
        from purchase_orders
        where ship_id = p_ship_id and item_code = rec.item_code and status is distinct from 'Received'
        order by coalesce(status_since, input_date) asc nulls last, po_id asc
      loop
        exit when v_remaining <= 0;
        if v_remaining >= poline.qty then
          -- full cover → mark Received (keep po_id), consume its qty.
          update purchase_orders set status = 'Received', receive_date = p_receive_date
           where po_id = poline.po_id;
          v_changes := v_changes || jsonb_build_object(
            'po_id', poline.po_id, 'change_type', 'received', 'is_new_row', false,
            'prior_status', poline.status, 'prior_status_since', poline.status_since,
            'prior_ship_id', poline.ship_id, 'prior_receive_date', poline.receive_date,
            'prior_qty', poline.qty, 'prior_shipment_note', poline.shipment_note);
          v_remaining := v_remaining - poline.qty;
        else
          -- partial → split: original keeps po_id (Received, qty = remaining); new strictly-positive
          -- Processing leftover row (all other fields copied). Leftover ship_id follows §4e (step 4).
          insert into purchase_orders (encrypt, supplier_id, item_code, customer_id, marketplace_order_id,
                                       item_cost, input_date, qty, status, status_since, ship_id)
          values (poline.encrypt, poline.supplier_id, poline.item_code, poline.customer_id,
                  poline.marketplace_order_id, poline.item_cost, poline.input_date,
                  poline.qty - v_remaining, 'Processing', p_receive_date, p_ship_id)
          returning po_id into v_new_po;
          v_new_pos := v_new_pos || v_new_po;
          v_changes := v_changes || jsonb_build_object(
            'po_id', v_new_po, 'change_type', 'split_new_leftover', 'is_new_row', true);

          update purchase_orders set status = 'Received', receive_date = p_receive_date, qty = v_remaining
           where po_id = poline.po_id;
          v_changes := v_changes || jsonb_build_object(
            'po_id', poline.po_id, 'change_type', 'split_received', 'is_new_row', false,
            'prior_status', poline.status, 'prior_status_since', poline.status_since,
            'prior_ship_id', poline.ship_id, 'prior_receive_date', poline.receive_date,
            'prior_qty', poline.qty, 'prior_shipment_note', poline.shipment_note);
          v_remaining := 0;
        end if;
      end loop;
    end if;
    -- v_remaining > 0 here = over-receipt: stock already added in (a); no PO change (window flags it).
  end loop;

  -- ── 4. close-tied revert (§4e). Revert ONLY on close. Leave-open: leftovers/un-counted stay on
  --       the shipment with their status UNTOUCHED (redline decision 5 — no downgrade, no breadcrumb).
  if v_close and v_is_ship then
    v_crumb := 'shorted from ' || p_ship_id || ' on ' || p_receive_date::text;
    for poline in
      select po_id, qty, status, status_since, ship_id, receive_date, shipment_note
      from purchase_orders where ship_id = p_ship_id and status is distinct from 'Received'
    loop
      update purchase_orders
         set ship_id = null, status = 'Processing', status_since = p_receive_date,
             shipment_note = case when shipment_note is null or btrim(shipment_note) = ''
                                  then v_crumb else shipment_note || ' · ' || v_crumb end
       where po_id = poline.po_id;
      -- new split-leftovers are already logged (is_new_row → reverse DELETES them); don't double-log.
      if not (poline.po_id = any(v_new_pos)) then
        v_changes := v_changes || jsonb_build_object(
          'po_id', poline.po_id, 'change_type', 'reverted', 'is_new_row', false,
          'prior_status', poline.status, 'prior_status_since', poline.status_since,
          'prior_ship_id', poline.ship_id, 'prior_receive_date', poline.receive_date,
          'prior_qty', poline.qty, 'prior_shipment_note', poline.shipment_note);
      end if;
    end loop;
    update shipments set received_date = p_receive_date, status = 'completed' where ship_id = p_ship_id;
  end if;

  -- ── 5. persist the change-log + return the handle the client/Reverse needs ──
  update receipts set po_changes = v_changes where receipt_id = v_receipt_id;
  select coalesce(array_agg(distinct item_code) filter (where item_code is not null), '{}')
    into v_codes from inbound where receipt_id = v_receipt_id;  -- incl. excluded-only SKUs (their PO flipped)

  return jsonb_build_object('receipt_id', v_receipt_id, 'affected', v_codes, 'closed', (v_close and v_is_ship));
end;
$$;

revoke all on function public.record_receipt(text, date, jsonb, boolean) from public, anon;
grant execute on function public.record_receipt(text, date, jsonb, boolean) to authenticated, service_role;

-- ============================================================================
-- 4. reverse_receipt() — mis-count recovery (reverse a confirmed receipt as a unit)
--    Compensating adjustment (source='reverse', note 'Reverse action') undoes the sellable stock;
--    the PO lines it mutated are RESTORED (un-Received, delete split leftovers, restore prior
--    ship_id/status/status_since/qty) and the shipment close is undone. Inbound rows stay as history.
-- ============================================================================

create or replace function public.reverse_receipt(
  p_receipt_id bigint,
  p_note       text default 'Reverse action'
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  r       receipts;
  v_email text := lower(auth.jwt() ->> 'email');
  v_note  text := coalesce(nullif(btrim(p_note), ''), 'Reverse action');
  v_codes text[];
  ch      jsonb;
begin
  -- atomic claim: only one txn flips active→reversed; the loser reads no row → friendly raise
  -- (closes the double-reverse TOCTOU — no read-then-write window).
  update receipts set status = 'reversed', reversed_at = now(), reversed_by = v_email, reverse_note = v_note
   where receipt_id = p_receipt_id and status = 'active';
  if not found then
    if not exists (select 1 from receipts where receipt_id = p_receipt_id) then
      raise exception 'reverse_receipt: receipt % not found', p_receipt_id;
    else
      raise exception 'reverse_receipt: receipt % is already reversed', p_receipt_id;
    end if;
  end if;
  select * into r from receipts where receipt_id = p_receipt_id;

  -- serialize against a concurrent record_receipt on the same ship_id, BEFORE the latest-only guard,
  -- so an in-flight receive's newer row is committed and visible to the guard (no TOCTOU bypass).
  perform pg_advisory_xact_lock(hashtext('jz_receive_ship'), hashtext(coalesce(r.ship_id, '')));

  -- latest-only guard (redline decision B): reversing UNDER a newer active receipt on the same
  -- ship_id would diverge stock/PO state — reverse the latest first.
  if exists (
    select 1 from receipts
    where ship_id is not distinct from r.ship_id and status = 'active' and receipt_id > p_receipt_id
  ) then
    raise exception 'reverse_receipt: a newer receipt exists for % — reverse the latest first', coalesce(r.ship_id, '(ad-hoc)');
  end if;

  -- 1. compensating adjustment for the SELLABLE stock this receipt added (per SKU).
  insert into adjustments (item_code, delta, source, note, created_by)
  select item_code, -sum(qty), 'reverse', v_note, v_email
  from inbound
  where receipt_id = p_receipt_id and not excluded and item_code is not null
  group by item_code
  having sum(qty) <> 0;

  -- 2. restore / delete the PO lines this receipt mutated.
  for ch in select * from jsonb_array_elements(r.po_changes) loop
    if coalesce((ch->>'is_new_row')::boolean, false) then
      delete from purchase_orders where po_id = (ch->>'po_id')::bigint;
    else
      update purchase_orders set
        status        = ch->>'prior_status',
        status_since  = nullif(ch->>'prior_status_since', '')::date,
        ship_id       = ch->>'prior_ship_id',
        receive_date  = nullif(ch->>'prior_receive_date', '')::date,
        qty           = (ch->>'prior_qty')::int,
        shipment_note = ch->>'prior_shipment_note'
      where po_id = (ch->>'po_id')::bigint;
    end if;
  end loop;

  -- 3. undo the shipment close.
  if r.closed and r.is_shipment then
    update shipments set status = r.prior_shipment_status, received_date = r.prior_shipment_received_date
     where ship_id = r.ship_id;
  end if;

  select coalesce(array_agg(distinct item_code) filter (where item_code is not null), '{}')
    into v_codes from inbound where receipt_id = p_receipt_id;
  return jsonb_build_object('receipt_id', p_receipt_id, 'affected', v_codes, 'reversed', true);
end;
$$;

revoke all on function public.reverse_receipt(bigint, text) from public, anon;
grant execute on function public.reverse_receipt(bigint, text) to authenticated, service_role;
