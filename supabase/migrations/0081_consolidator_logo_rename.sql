-- PR276 — Consolidators (forwarders): a logo, and an editable prefix that cascades to every ship_id.
--
-- (1) forwarders.logo — a per-consolidator logo (emoji or uploaded-image URL, same convention as the
--     settings-icons `icon`). Shown in the Consolidators list.
-- (2) The prefix is the PK, embedded in every ship_id ('SUB 192') and referenced by shipments. To let it
--     be renamed we (a) make the two ship-id/prefix foreign keys ON UPDATE CASCADE, and (b) add a guarded
--     function that rewrites the free-text ship_ids (purchase_orders / inbound / receipts — no FK) and the
--     shipments themselves; shipment_boxes.ship_id and shipments.forwarder_prefix then follow by cascade.
-- Idempotent.

alter table public.forwarders add column if not exists logo text;

-- ── make the two relevant FKs cascade on UPDATE so a prefix / ship_id rename propagates automatically ──
alter table public.shipments      drop constraint if exists shipments_forwarder_prefix_fkey;
alter table public.shipments      add  constraint shipments_forwarder_prefix_fkey
  foreign key (forwarder_prefix) references public.forwarders(prefix) on update cascade;

alter table public.shipment_boxes drop constraint if exists shipment_boxes_ship_id_fkey;
alter table public.shipment_boxes add  constraint shipment_boxes_ship_id_fkey
  foreign key (ship_id) references public.shipments(ship_id) on update cascade on delete cascade;

-- ── rename a consolidator's prefix, rewriting every owned ship_id across the pipeline ──
-- Only ship_ids that actually begin with the old prefix are rewritten (a hand-typed odd id is left alone
-- but still follows the forwarder_prefix cascade). Children with NO fk (purchase_orders / inbound /
-- receipts) are rewritten explicitly, BEFORE shipments changes, while their ids still match. Then
-- shipments.ship_id is rewritten (shipment_boxes cascades) and finally forwarders.prefix (shipments.
-- forwarder_prefix cascades). Runs in the caller's transaction — all-or-nothing.
create or replace function public.rename_consolidator_prefix(p_old text, p_new text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old text := btrim(p_old);
  v_new text := btrim(p_new);
begin
  if v_new = '' then raise exception 'rename_consolidator_prefix: a new prefix is required'; end if;
  if v_old = v_new then return; end if;
  if not exists (select 1 from forwarders where prefix = v_old) then
    raise exception 'rename_consolidator_prefix: consolidator % not found', v_old;
  end if;
  if exists (select 1 from forwarders where prefix = v_new) then
    raise exception 'rename_consolidator_prefix: prefix % already exists', v_new;
  end if;

  -- free-text children (no FK): rewrite the leading prefix on ids owned by this consolidator, while
  -- their ship_id still matches shipments' (unchanged) ship_id.
  update purchase_orders p set ship_id = v_new || substr(p.ship_id, length(v_old) + 1)
    from shipments s
   where p.ship_id = s.ship_id and s.forwarder_prefix = v_old and p.ship_id like v_old || '%';
  update inbound i set ship_id = v_new || substr(i.ship_id, length(v_old) + 1)
    from shipments s
   where i.ship_id = s.ship_id and s.forwarder_prefix = v_old and i.ship_id like v_old || '%';
  update receipts r set ship_id = v_new || substr(r.ship_id, length(v_old) + 1)
    from shipments s
   where r.ship_id = s.ship_id and s.forwarder_prefix = v_old and r.ship_id like v_old || '%';

  -- shipments.ship_id (shipment_boxes.ship_id cascades) — only the ones that carry the old prefix.
  update shipments set ship_id = v_new || substr(ship_id, length(v_old) + 1)
   where forwarder_prefix = v_old and ship_id like v_old || '%';

  -- finally rename the consolidator (shipments.forwarder_prefix cascades to v_new).
  update forwarders set prefix = v_new where prefix = v_old;
end;
$$;

revoke all on function public.rename_consolidator_prefix(text, text) from public, anon;
grant execute on function public.rename_consolidator_prefix(text, text) to authenticated, service_role;
