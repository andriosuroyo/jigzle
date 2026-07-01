-- Group POs into a shipment with per-line partial quantities — PR124.
-- The To-ship group panel now lets you ship LESS than a PO's full qty (e.g. PO qty 2, send 1). This
-- supersedes group_pos_into_shipment (whole-line only) with a v2 that takes a jsonb array of
-- {po_id, qty}. For a partial line the ORIGINAL po_id keeps the remainder (stays in To ship, ship_id
-- NULL) and a NEW row carries the shipped portion (qty, ship_id set, status With Forwarder) — the same
-- split shape record_receipt uses. A full/absent qty attaches the whole line unchanged. Atomic: the
-- shipments upsert + every split happen in one function. SECURITY INVOKER + pinned search_path, same
-- posture as group_pos_into_shipment / record_receipt (RLS is_allowed_user() gates every write).

create or replace function public.group_pos_into_shipment_v2(
  p_ship_id          text,
  p_items            jsonb,       -- [{ "po_id": <bigint>, "qty": <number|null> }]
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
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'group_pos_into_shipment_v2: at least one item is required';
  end if;
  if v_ship_id is null or v_ship_id = '' then
    raise exception 'group_pos_into_shipment_v2: a ship_id is required';
  end if;

  -- upsert the shipments ledger row (open). forwarder_prefix is the FK to forwarders(prefix) — a
  -- non-existent prefix raises here, which is the intended guard.
  insert into shipments (ship_id, forwarder_prefix, origin_country, ship_date, status)
  values (v_ship_id,
          nullif(btrim(p_forwarder_prefix), ''),
          nullif(btrim(p_origin_country), ''),
          p_ship_date,
          'open')
  on conflict (ship_id) do update
    set forwarder_prefix = excluded.forwarder_prefix,
        origin_country   = excluded.origin_country,
        ship_date        = excluded.ship_date,
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
      -- whole line → attach unchanged
      update purchase_orders
         set ship_id = v_ship_id, status = 'With Forwarder', status_since = current_date
       where po_id = v_po_id;
      v_ids := v_ids || v_po_id;
    elsif v_send = 0 then
      raise exception 'group_pos_into_shipment_v2: send qty must be > 0 for po_id %', v_po_id;
    else
      -- partial → new row carries the shipped portion (attached); original keeps the remainder in To ship
      insert into purchase_orders (
        encrypt, supplier_id, item_code, item_code_raw, qty, status, status_since, item_cost, method,
        ship_id, customs_value_usd, tracking_to_wh, tracking_to_forwarder, tracking_to_jigzle,
        marketplace_order_id, customer_id, item_note, shipment_note, input_date, product_link)
      values (
        v_cur.encrypt, v_cur.supplier_id, v_cur.item_code, v_cur.item_code_raw, v_send, 'With Forwarder', current_date, v_cur.item_cost, v_cur.method,
        v_ship_id, v_cur.customs_value_usd, v_cur.tracking_to_wh, v_cur.tracking_to_forwarder, v_cur.tracking_to_jigzle,
        v_cur.marketplace_order_id, v_cur.customer_id, v_cur.item_note, v_cur.shipment_note, v_cur.input_date, v_cur.product_link)
      returning po_id into v_new_id;

      update purchase_orders
         set qty = v_cur.qty - v_send, status = 'With Forwarder', status_since = current_date
       where po_id = v_po_id;
      v_ids := v_ids || v_new_id;
    end if;
  end loop;

  return v_ids;
end;
$$;

revoke all on function public.group_pos_into_shipment_v2(text, jsonb, text, text, date) from public, anon;
grant execute on function public.group_pos_into_shipment_v2(text, jsonb, text, text, date) to authenticated, service_role;
