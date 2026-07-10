-- PR271 — record the shortfall ON the shipment note (Purchasing → History), never over it.
--
-- When a shipment is received short and closed, record_receipt already (a) splits each partially-received
-- PO line so the received part is marked Received and the un-arrived remainder becomes a leftover row, and
-- (b) §4e reverts every still-open line to Ship (ship_id NULL, With Forwarder) with a "shorted from <ship>"
-- breadcrumb on the PO line (drives the Ship card's "Short · from…" badge). What was MISSING, though, was
-- any trace on the SHIPMENT itself — Purchasing → History's "Shipment notes" reads shipments.note, which
-- record_receipt never touched. So a completed shipment gave no hint of what didn't arrive.
--
-- This recreates record_receipt with ONE addition inside the §4e close block: before reverting, it
-- summarizes the shorted lines (item_code ×qty) and APPENDS that to shipments.note — written ON, not over,
-- so a hand-typed note is preserved (newline-joined). Everything else is byte-identical to 0076. The
-- items still flow back to Ship exactly as before; the History quantity is unchanged by this migration.
-- Idempotent (create or replace); no new column (shipments.note is PR153-era).

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
  v_short_note  text;   -- PR271: "SKU-A ×1, SKU-B ×2" summary of what did not arrive
  v_new_po      bigint;
  v_remaining   int;
  rec           record;
  poline        record;
begin
  -- ── 0. VALIDATE-BEFORE-WRITE (zero residue on reject + friendly errors) ──
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1 then
    raise exception 'record_receipt: at least one receive line is required';
  end if;

  select array_agg(distinct code) into v_missing
  from (
    select coalesce(nullif(l->>'item_code', ''), '(blank)') as code
    from jsonb_array_elements(p_lines) as l
  ) s
  where not exists (select 1 from catalogue c where c.item_code = s.code);
  if v_missing is not null then
    raise exception 'record_receipt: unknown/blank item_code(s): %', array_to_string(v_missing, ', ');
  end if;

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
  if exists (
    select 1 from jsonb_array_elements(p_lines) l
    where nullif(l->>'excluded_qty', '') is not null and (l->>'excluded_qty') !~ '^-?[0-9]+$'
  ) then
    raise exception 'record_receipt: excluded_qty must be an integer';
  end if;

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

  -- ── 1. concurrency guard ──
  perform pg_advisory_xact_lock(hashtext('jz_receive_ship'), hashtext(coalesce(p_ship_id, '')));

  select tracking, status, received_date into v_tracking, v_ship_status, v_ship_recv
    from shipments where ship_id = p_ship_id;
  v_is_ship := found;
  if v_is_ship and v_ship_status = 'completed' then
    raise exception 'record_receipt: shipment % is already completed', p_ship_id;
  end if;

  -- ── 2. open the receipt header ──
  insert into receipts (ship_id, receive_date, is_shipment, closed,
                        prior_shipment_status, prior_shipment_received_date, created_by)
  values (p_ship_id, p_receive_date, v_is_ship, (v_close and v_is_ship),
          v_ship_status, v_ship_recv, lower(auth.jwt() ->> 'email'))
  returning receipt_id into v_receipt_id;

  -- ── 3. per SKU: enter arrivals, then allocate against open PO lines oldest-first ──
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
    if rec.counted <> 0 or rec.excluded_qty > 0 then
      insert into inbound (item_code, qty, ship_id, receive_date, excluded, excluded_qty,
                           label, receive_note, dimension_weight, tracking, receipt_id)
      values (rec.item_code, rec.counted - rec.excluded_qty, p_ship_id, p_receive_date,
              false, rec.excluded_qty, rec.label,
              case when rec.excluded_qty > 0 then rec.reason else null end,
              rec.dim, v_tracking, v_receipt_id);
    end if;

    v_remaining := greatest(rec.counted, 0);
    if v_remaining > 0 then
      for poline in
        select po_id, qty, status, status_since, ship_id, receive_date, shipment_note,
               encrypt, supplier_id, item_code, item_code_raw, customer_id, marketplace_order_id,
               item_cost, method, tracking_to_forwarder, product_link, item_note,
               customs_value_usd, tracking_to_wh, tracking_to_jigzle, input_date
        from purchase_orders
        where ship_id = p_ship_id and item_code = rec.item_code and status is distinct from 'Received'
        order by coalesce(status_since, input_date) asc nulls last, po_id asc
      loop
        exit when v_remaining <= 0;
        if v_remaining >= poline.qty then
          update purchase_orders set status = 'Received', receive_date = p_receive_date
           where po_id = poline.po_id;
          v_changes := v_changes || jsonb_build_object(
            'po_id', poline.po_id, 'change_type', 'received', 'is_new_row', false,
            'prior_status', poline.status, 'prior_status_since', poline.status_since,
            'prior_ship_id', poline.ship_id, 'prior_receive_date', poline.receive_date,
            'prior_qty', poline.qty, 'prior_shipment_note', poline.shipment_note);
          v_remaining := v_remaining - poline.qty;
        else
          -- partial → split: original keeps po_id (Received, qty = remaining); new leftover row carries
          -- the un-arrived qty with the FULL detail set (PR268). §4e reverts it to Ship (ship_id NULL).
          insert into purchase_orders (
            encrypt, supplier_id, item_code, item_code_raw, qty, status, status_since, item_cost, method,
            ship_id, customs_value_usd, tracking_to_wh, tracking_to_forwarder, tracking_to_jigzle,
            marketplace_order_id, customer_id, item_note, shipment_note, input_date, product_link)
          values (
            poline.encrypt, poline.supplier_id, poline.item_code, poline.item_code_raw, poline.qty - v_remaining, 'Processing', p_receive_date, poline.item_cost, poline.method,
            p_ship_id, poline.customs_value_usd, poline.tracking_to_wh, poline.tracking_to_forwarder, poline.tracking_to_jigzle,
            poline.marketplace_order_id, poline.customer_id, poline.item_note, poline.shipment_note, poline.input_date, poline.product_link)
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
  end loop;

  -- ── 4. close-tied revert (§4e): shorted lines → Ship (With Forwarder, ship_id NULL) with a crumb. ──
  if v_close and v_is_ship then
    v_crumb := 'shorted from ' || p_ship_id || ' on ' || p_receive_date::text;

    -- PR271: summarize what did NOT arrive (item_code ×qty), while the lines are still on this ship_id,
    -- so we can append it to the shipment note below. '(no SKU)' for a raw/unmapped line.
    select string_agg(code || ' ×' || q::text, ', ' order by code)
      into v_short_note
    from (
      select coalesce(nullif(item_code, ''), nullif(item_code_raw, ''), '(no SKU)') as code, sum(qty) as q
      from purchase_orders
      where ship_id = p_ship_id and status is distinct from 'Received'
      group by 1
    ) s;

    for poline in
      select po_id, qty, status, status_since, ship_id, receive_date, shipment_note
      from purchase_orders where ship_id = p_ship_id and status is distinct from 'Received'
    loop
      update purchase_orders
         set ship_id = null, status = 'With Forwarder', status_since = p_receive_date,
             shipment_note = case when shipment_note is null or btrim(shipment_note) = ''
                                  then v_crumb else shipment_note || ' · ' || v_crumb end
       where po_id = poline.po_id;
      if not (poline.po_id = any(v_new_pos)) then
        v_changes := v_changes || jsonb_build_object(
          'po_id', poline.po_id, 'change_type', 'reverted', 'is_new_row', false,
          'prior_status', poline.status, 'prior_status_since', poline.status_since,
          'prior_ship_id', poline.ship_id, 'prior_receive_date', poline.receive_date,
          'prior_qty', poline.qty, 'prior_shipment_note', poline.shipment_note);
      end if;
    end loop;

    -- close the shipment; PR271: append the shortfall summary ON the note (never clobber a typed note).
    update shipments
       set received_date = p_receive_date,
           status        = 'completed',
           note = case
                    when v_short_note is null then note
                    when note is null or btrim(note) = ''
                      then 'Not received on ' || to_char(p_receive_date, 'FMMon FMDD, YYYY') || ': ' || v_short_note
                    else note || E'\n' || 'Not received on ' || to_char(p_receive_date, 'FMMon FMDD, YYYY') || ': ' || v_short_note
                  end
     where ship_id = p_ship_id;
  end if;

  -- ── 5. persist the change-log + return ──
  update receipts set po_changes = v_changes where receipt_id = v_receipt_id;
  select coalesce(array_agg(distinct item_code) filter (where item_code is not null), '{}')
    into v_codes from inbound where receipt_id = v_receipt_id;

  return jsonb_build_object('receipt_id', v_receipt_id, 'affected', v_codes, 'closed', (v_close and v_is_ship));
end;
$$;

revoke all on function public.record_receipt(text, date, jsonb, boolean) from public, anon;
grant execute on function public.record_receipt(text, date, jsonb, boolean) to authenticated, service_role;
