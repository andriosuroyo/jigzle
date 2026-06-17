-- Phase 1 — Procurement module: the buying pipeline BEFORE Receiving (docs/007).
-- The tables already exist (0007_procurement.sql) and are filled by the import; this migration
-- adds the ONE transactional write path Procurement needs:
--
--   group_pos_into_shipment() — attach a set of open POs to a forwarder shipment in one
--     transaction: upsert the shipments ledger row (open) and advance every selected PO to
--     'With Forwarder' with the same ship_id. That ship_id is the hand-off to Receiving, which
--     reconciles against it (record_receipt, 0015). Returns the updated po_ids so the client
--     can re-read.
--
-- PO / supplier / forwarder create + edit + status are single-table, RLS-gated writes done
-- directly from the app (no RPC) — only the multi-row + shipments-upsert grouping needs a
-- transaction, hence this single function.
--
-- group_pos_into_shipment is SECURITY INVOKER with a pinned search_path — same posture as
-- record_receipt / create_order / fulfill_order / record_shipment: the app calls it with the
-- anon key + the signed-in user's session, so RLS (is_allowed_user()) gates every write;
-- service_role (the smoke harness) may also call it. Does NOT touch the stock_check view
-- (0009 already derives pending + on_the_way from purchase_orders), the importer, the
-- procurement tables (0007), or any other RPC.

-- ============== group_pos_into_shipment() ==============
create or replace function public.group_pos_into_shipment(
  p_ship_id          text,
  p_po_ids           bigint[],
  p_forwarder_prefix text,
  p_origin_country   text,
  p_ship_date        date
) returns bigint[]
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_ship_id  text := btrim(p_ship_id);
  v_missing  bigint[];
  v_received bigint[];
  v_ids      bigint[];
begin
  -- 1. validate the inputs, failing loudly listing the offenders (same style as record_receipt).
  if p_po_ids is null or array_length(p_po_ids, 1) is null then
    raise exception 'group_pos_into_shipment: at least one po_id is required';
  end if;
  if v_ship_id is null or v_ship_id = '' then
    raise exception 'group_pos_into_shipment: a ship_id is required';
  end if;

  -- every po_id must exist
  select array_agg(id order by id) into v_missing
  from unnest(p_po_ids) as id
  where not exists (select 1 from purchase_orders po where po.po_id = id);
  if v_missing is not null then
    raise exception 'group_pos_into_shipment: unknown po_id(s): %', array_to_string(v_missing, ', ');
  end if;

  -- none already Received (Receiving owns that terminal state — record_receipt sets it)
  select array_agg(po.po_id order by po.po_id) into v_received
  from purchase_orders po
  where po.po_id = any(p_po_ids) and po.status = 'Received';
  if v_received is not null then
    raise exception 'group_pos_into_shipment: po_id(s) already Received: %', array_to_string(v_received, ', ');
  end if;

  -- 2. upsert the shipments ledger row (status open). forwarder_prefix is the FK to
  --    forwarders(prefix) — a non-existent prefix raises here, which is the intended guard.
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

  -- 3. attach every selected PO to the shipment and advance it to With Forwarder.
  update purchase_orders
     set ship_id      = v_ship_id,
         status       = 'With Forwarder',
         status_since = current_date
   where po_id = any(p_po_ids);

  -- 4. return the updated po_ids.
  select array_agg(po.po_id order by po.po_id) into v_ids
  from purchase_orders po
  where po.po_id = any(p_po_ids);
  return v_ids;
end;
$$;

revoke all on function public.group_pos_into_shipment(text, bigint[], text, text, date) from public, anon;
grant execute on function public.group_pos_into_shipment(text, bigint[], text, text, date) to authenticated, service_role;
