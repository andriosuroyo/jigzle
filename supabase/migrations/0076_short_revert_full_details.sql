-- PR268 — the auto short-revert must carry the FULL item detail to Ship.
-- When only 2 of 3 arrive and the shipment is closed, record_receipt splits the PO: the received part
-- is marked Received, and a leftover row (the un-arrived 1) is reverted to Ship (ship_id NULL, With
-- Forwarder). The 0073 split copied only supplier / item_cost / marketplace id — so the leftover lost
-- its item link, local courier, local tracking, notes, and item_code_raw. This recreates record_receipt
-- copying the SAME full field set group_pos_into_shipment_v2 / send_po_back_to_ship use, so the extra
-- unit lands back in Ship with everything intact. Only the §3 allocation loop's SELECT + split INSERT
-- change vs 0073; everything else is identical. Idempotent (create or replace).

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
        -- PR268: select the FULL detail set so a split leftover keeps everything.
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
    update shipments set received_date = p_receive_date, status = 'completed' where ship_id = p_ship_id;
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
