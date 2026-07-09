-- PR257 — short-revert lands in Purchasing → To ship (not To forwarder).
--
-- record_receipt's close-tied revert (0023 §4e) sent un-arrived ("shorted") lines back with
-- status = 'Processing', which put them in Purchasing → TO FORWARDER — but a shorted line was
-- already confirmed with the forwarder (it was grouped into a shipment from To ship), so the
-- correct place to re-group it from is TO SHIP. This re-creates record_receipt with ONE change:
-- the revert sets status = 'With Forwarder' (ship_id still cleared, breadcrumb unchanged), so a
-- shorted line reappears in To ship carrying its "Short · from <ship_id>" badge (which the To-ship
-- card already renders). Over-receipts are untouched: stock is added for everything counted and
-- the surplus simply doesn't move any PO.
--
-- Everything else is byte-identical to 0023 (same signature → plain create or replace; reverse_
-- receipt needs no change — it restores the PRIOR values captured in the change log). Idempotent:
-- safe to re-run.

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
  --       PR257: a shorted line goes back to 'With Forwarder' (Purchasing → TO SHIP, ready to be
  --       re-grouped) instead of 'Processing' (To forwarder) — it was already forwarder-confirmed.
  if v_close and v_is_ship then
    v_crumb := 'shorted from ' || p_ship_id || ' on ' || p_receive_date::text;
    for poline in
      select po_id, qty, status, status_since, ship_id, receive_date, shipment_note
      from purchase_orders where ship_id = p_ship_id and status is distinct from 'Received'
    loop
      update purchase_orders
         set ship_id = null, status = 'With Forwarder', status_since = p_receive_date,
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
