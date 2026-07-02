-- Editable Ship ID for a received History entry (map-at-leisure). A receiver in a hurry can book goods
-- under a temporary / ad-hoc ship id, then later correct it to the real one. Because PO allocation
-- happens at receive time keyed by ship_id, a plain rename would leave the new shipment's POs open. So
-- this MOVES the receipt properly: it hard-reverses the old receipt's PO effects (no compensating
-- adjustment — the stock is relocating, not disappearing), deletes the old inbound + receipt rows, then
-- REPLAYS through the existing record_receipt() under the new ship id, which re-runs allocation + close.
-- Original receive_date, created_at (the History timestamp) and staff are preserved on the new rows.
--
-- Handles a ship_id that carried several receipts (each moved oldest-first) and legacy inbound rows with
-- no receipt_id (bulk imports — relocated by a plain ship_id update, since they never allocated a PO).
-- One function = one transaction: if the replay raises (e.g. the target shipment is already completed),
-- the whole move rolls back. SECURITY INVOKER so RLS (is_allowed_user) still gates every table it touches.

create or replace function public.move_ship_id(
  p_old_ship_id text,
  p_new_ship_id text,
  p_close       boolean default false
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old      text := btrim(coalesce(p_old_ship_id, ''));
  v_new      text := btrim(coalesce(p_new_ship_id, ''));
  v_ids      bigint[];
  v_rid      bigint;
  r          receipts;
  ch         jsonb;
  v_lines    jsonb;
  v_date     date;
  v_created  timestamptz;
  v_staff    text;
  v_res      jsonb;
  v_new_rid  bigint;
  v_moved    int := 0;
  v_legacy   int := 0;
begin
  if v_old = '' or v_new = '' then raise exception 'move_ship_id: old and new ship id are required'; end if;
  if v_old = v_new then raise exception 'move_ship_id: the new ship id is the same as the old one'; end if;

  -- serialize against concurrent receives/reverses on either ship id
  perform pg_advisory_xact_lock(hashtext('jz_receive_ship'), hashtext(v_old));
  perform pg_advisory_xact_lock(hashtext('jz_receive_ship'), hashtext(v_new));

  -- snapshot the active receipts on the old id (oldest first → stable allocation order on replay)
  select array_agg(receipt_id order by receipt_id)
    into v_ids
    from receipts where ship_id = v_old and status = 'active';

  foreach v_rid in array coalesce(v_ids, '{}') loop
    select * into r from receipts where receipt_id = v_rid;

    -- capture this receipt's lines to replay: counted = sellable qty + excluded_qty (record_receipt's
    -- allocation base), carrying the exclude/label/dim detail. Also its original stamp + staff.
    select coalesce(jsonb_agg(jsonb_build_object(
             'item_code', item_code,
             'qty', qty + coalesce(excluded_qty, 0),
             'excluded_qty', coalesce(excluded_qty, 0),
             'exclude_reason', receive_note,
             'label', label,
             'dimension_weight', dimension_weight)), '[]'::jsonb),
           max(receive_date), max(created_at), max(staff)
      into v_lines, v_date, v_created, v_staff
      from inbound
      where receipt_id = v_rid and not is_opening_balance;

    if v_lines = '[]'::jsonb then continue; end if;

    -- HARD reverse of the PO effects (mirrors reverse_receipt minus the compensating adjustment):
    -- restore/delete the PO lines this receipt mutated, then un-close the old shipment.
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
    if r.closed and r.is_shipment then
      update shipments set status = r.prior_shipment_status, received_date = r.prior_shipment_received_date
       where ship_id = v_old;
    end if;

    -- drop the old inbound + receipt (clean relocate — no residue), then replay under the new id.
    delete from inbound  where receipt_id = v_rid;
    delete from receipts where receipt_id = v_rid;

    v_res     := record_receipt(v_new, v_date, v_lines, p_close);
    v_new_rid := (v_res->>'receipt_id')::bigint;

    -- preserve the original History timestamp + staff on the replayed rows
    update inbound set created_at = v_created, staff = v_staff where receipt_id = v_new_rid;

    v_moved := v_moved + 1;
  end loop;

  -- legacy rows with no receipt_id (bulk imports): a plain relocate — they never allocated a PO.
  update inbound set ship_id = v_new
   where ship_id = v_old and receipt_id is null and not is_opening_balance;
  get diagnostics v_legacy = row_count;

  if v_moved = 0 and v_legacy = 0 then
    raise exception 'move_ship_id: nothing to move under %', v_old;
  end if;

  return jsonb_build_object('moved_receipts', v_moved, 'legacy_rows', v_legacy, 'new_ship_id', v_new);
end;
$$;

revoke all on function public.move_ship_id(text, text, boolean) from public, anon;
grant execute on function public.move_ship_id(text, text, boolean) to authenticated, service_role;
