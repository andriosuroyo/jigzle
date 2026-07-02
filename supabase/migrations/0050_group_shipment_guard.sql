-- Harden group_pos_into_shipment_v2 (audit H1/M1/M5) — PR128.
-- Three fixes to the To-ship grouping upsert:
--  H1  Never silently REOPEN a completed shipment. Since the group panel pre-fills the last (usually
--      completed) ship id, an un-bumped "Group shipment" would flip a completed shipment back to open,
--      drop it from History, and let a later receive overwrite its received_date. Now we RAISE if the
--      target ship_id is a completed shipment — the operator must use a new number (or an open one).
--      (Mirrors record_receipt's refusal to receive into a completed shipment.)
--  M1  Adding items to an EXISTING open shipment must not clobber its stored ship_date / forwarder /
--      origin with today's blanks. Use coalesce(existing, new) so those only fill when currently NULL.
--  M5  Grouping must not reset the age of an already-With-Forwarder line (To-ship cards show
--      status_since as their date). Keep status_since when the line is already With Forwarder; the split
--      remainder keeps its date; the new shipped row inherits the original's date. New stamps use the
--      Asia/Jakarta date (the app's convention), not server-UTC current_date.

create or replace function public.group_pos_into_shipment_v2(
  p_ship_id          text,
  p_items            jsonb,
  p_forwarder_prefix text,
  p_origin_country   text,
  p_ship_date        date
) returns bigint[]
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_ship_id text := btrim(p_ship_id);
  v_ids     bigint[] := '{}';
  v_item    jsonb;
  v_po_id   bigint;
  v_send    numeric;
  v_cur     purchase_orders%rowtype;
  v_new_id  bigint;
  v_existing_status text;
  v_today   date := (now() at time zone 'Asia/Jakarta')::date;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'group_pos_into_shipment_v2: at least one item is required';
  end if;
  if v_ship_id is null or v_ship_id = '' then
    raise exception 'group_pos_into_shipment_v2: a ship_id is required';
  end if;

  -- H1: refuse to group into a shipment that is already completed (would silently reopen it).
  select status into v_existing_status from shipments where ship_id = v_ship_id;
  if v_existing_status = 'completed' then
    raise exception 'group_pos_into_shipment_v2: % is a completed shipment — use a new ship id (or bump the number)', v_ship_id;
  end if;

  -- upsert the shipments ledger row (open). M1: coalesce so an existing open shipment keeps its stored
  -- ship_date / forwarder / origin instead of being overwritten with today's / the picked blanks.
  insert into shipments (ship_id, forwarder_prefix, origin_country, ship_date, status)
  values (v_ship_id,
          nullif(btrim(p_forwarder_prefix), ''),
          nullif(btrim(p_origin_country), ''),
          p_ship_date,
          'open')
  on conflict (ship_id) do update
    set forwarder_prefix = coalesce(shipments.forwarder_prefix, excluded.forwarder_prefix),
        origin_country   = coalesce(shipments.origin_country, excluded.origin_country),
        ship_date        = coalesce(shipments.ship_date, excluded.ship_date),
        status           = 'open';

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_po_id := (v_item->>'po_id')::bigint;
    v_send  := coalesce((v_item->>'qty')::numeric, -1);

    select * into v_cur from purchase_orders where po_id = v_po_id;
    if not found then
      raise exception 'group_pos_into_shipment_v2: unknown po_id %', v_po_id;
    end if;
    if v_cur.status = 'Received' then
      raise exception 'group_pos_into_shipment_v2: po_id % already Received', v_po_id;
    end if;

    if v_send < 0 or v_send >= v_cur.qty then
      -- whole line → attach. M5: keep status_since if already With Forwarder (don't reset its age).
      update purchase_orders
         set ship_id = v_ship_id,
             status = 'With Forwarder',
             status_since = case when v_cur.status = 'With Forwarder' then v_cur.status_since else v_today end
       where po_id = v_po_id;
      v_ids := v_ids || v_po_id;
    elsif v_send = 0 then
      raise exception 'group_pos_into_shipment_v2: send qty must be > 0 for po_id %', v_po_id;
    else
      -- partial → new row carries the shipped portion; original keeps the remainder in To ship.
      -- M5: the new row inherits the original's status_since (same age); the remainder keeps its own.
      insert into purchase_orders (
        encrypt, supplier_id, item_code, item_code_raw, qty, status, status_since, item_cost, method,
        ship_id, customs_value_usd, tracking_to_wh, tracking_to_forwarder, tracking_to_jigzle,
        marketplace_order_id, customer_id, item_note, shipment_note, input_date, product_link)
      values (
        v_cur.encrypt, v_cur.supplier_id, v_cur.item_code, v_cur.item_code_raw, v_send, 'With Forwarder',
        coalesce(v_cur.status_since, v_today), v_cur.item_cost, v_cur.method,
        v_ship_id, v_cur.customs_value_usd, v_cur.tracking_to_wh, v_cur.tracking_to_forwarder, v_cur.tracking_to_jigzle,
        v_cur.marketplace_order_id, v_cur.customer_id, v_cur.item_note, v_cur.shipment_note, v_cur.input_date, v_cur.product_link)
      returning po_id into v_new_id;

      update purchase_orders
         set qty = v_cur.qty - v_send   -- status stays With Forwarder; status_since (age) unchanged
       where po_id = v_po_id;
      v_ids := v_ids || v_new_id;
    end if;
  end loop;

  return v_ids;
end;
$$;

revoke all on function public.group_pos_into_shipment_v2(text, jsonb, text, text, date) from public, anon;
grant execute on function public.group_pos_into_shipment_v2(text, jsonb, text, text, date) to authenticated, service_role;
