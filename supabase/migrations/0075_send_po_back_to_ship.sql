-- PR267 — "Send back to Ship" from Purchasing → History (a grouped/Active shipment line).
-- The inverse of group_pos_into_shipment_v2's attach: detach some/all of a not-yet-received line from
-- its shipment back to the Ship queue (ship_id NULL, status 'With Forwarder'). A partial send-back
-- SPLITS the line — a new row carries the sent-back qty (unassigned), the original keeps the remainder
-- attached to the shipment. Use case: x3 were grouped but only x2 will arrive, so x1 goes back to Ship
-- to be investigated / re-grouped. Atomic; SECURITY INVOKER + pinned search_path (RLS gates writes).
-- Idempotent / re-runnable (create or replace).

create or replace function public.send_po_back_to_ship(
  p_po_id bigint,
  p_qty   int
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cur    purchase_orders%rowtype;
  v_new_id bigint;
begin
  select * into v_cur from purchase_orders where po_id = p_po_id;
  if not found then
    raise exception 'send_po_back_to_ship: unknown po_id %', p_po_id;
  end if;
  if v_cur.status = 'Received' then
    raise exception 'send_po_back_to_ship: po_id % is already Received', p_po_id;
  end if;
  if v_cur.ship_id is null then
    raise exception 'send_po_back_to_ship: po_id % is not attached to a shipment', p_po_id;
  end if;
  if p_qty is null or p_qty < 1 or p_qty > v_cur.qty then
    raise exception 'send_po_back_to_ship: qty must be between 1 and %', v_cur.qty;
  end if;

  if p_qty >= v_cur.qty then
    -- whole line → detach it back to Ship (unchanged qty)
    update purchase_orders
       set ship_id = null, status = 'With Forwarder', status_since = current_date
     where po_id = p_po_id;
    return jsonb_build_object('po_id', p_po_id, 'split', false);
  else
    -- partial → new UNASSIGNED row carries the sent-back qty; original keeps the remainder attached.
    insert into purchase_orders (
      encrypt, supplier_id, item_code, item_code_raw, qty, status, status_since, item_cost, method,
      ship_id, customs_value_usd, tracking_to_wh, tracking_to_forwarder, tracking_to_jigzle,
      marketplace_order_id, customer_id, item_note, shipment_note, input_date, product_link)
    values (
      v_cur.encrypt, v_cur.supplier_id, v_cur.item_code, v_cur.item_code_raw, p_qty, 'With Forwarder', current_date, v_cur.item_cost, v_cur.method,
      null, v_cur.customs_value_usd, v_cur.tracking_to_wh, v_cur.tracking_to_forwarder, v_cur.tracking_to_jigzle,
      v_cur.marketplace_order_id, v_cur.customer_id, v_cur.item_note, v_cur.shipment_note, v_cur.input_date, v_cur.product_link)
    returning po_id into v_new_id;

    update purchase_orders set qty = v_cur.qty - p_qty where po_id = p_po_id;
    return jsonb_build_object('po_id', p_po_id, 'new_po_id', v_new_id, 'split', true);
  end if;
end;
$$;

revoke all on function public.send_po_back_to_ship(bigint, int) from public, anon;
grant execute on function public.send_po_back_to_ship(bigint, int) to authenticated, service_role;
