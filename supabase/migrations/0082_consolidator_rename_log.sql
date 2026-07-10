-- PR277 — a paper trail for consolidator-prefix renames (which rewrite historical ship_ids).
--
-- (1) consolidator_rename_log — one row per rename: old → new prefix, how many ship_ids were rewritten,
--     who did it, when. Read-only history; is_allowed_user() gates select + insert (the insert happens
--     inside the SECURITY INVOKER rename function, i.e. as the calling user).
-- (2) rename_consolidator_prefix is recreated to RETURN the count of ship_ids touched and to write the
--     log row. The return type changes (void → integer), so it must be dropped first. Logic is otherwise
--     identical to 0081. Idempotent.

create table if not exists public.consolidator_rename_log (
  id               bigint generated always as identity primary key,
  old_prefix       text not null,
  new_prefix       text not null,
  ship_ids_touched int  not null default 0,
  renamed_by       text,
  created_at       timestamptz not null default now()
);

alter table public.consolidator_rename_log enable row level security;
drop policy if exists "consolidator_rename_log_all" on public.consolidator_rename_log;
create policy "consolidator_rename_log_all" on public.consolidator_rename_log
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());
grant select, insert on public.consolidator_rename_log to authenticated, service_role;

-- recreate with a return value + logging (return type change → drop first).
drop function if exists public.rename_consolidator_prefix(text, text);
create or replace function public.rename_consolidator_prefix(p_old text, p_new text)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old   text := btrim(p_old);
  v_new   text := btrim(p_new);
  v_count int  := 0;
begin
  if v_new = '' then raise exception 'rename_consolidator_prefix: a new prefix is required'; end if;
  if v_old = v_new then return 0; end if;
  if not exists (select 1 from forwarders where prefix = v_old) then
    raise exception 'rename_consolidator_prefix: consolidator % not found', v_old;
  end if;
  if exists (select 1 from forwarders where prefix = v_new) then
    raise exception 'rename_consolidator_prefix: prefix % already exists', v_new;
  end if;

  -- how many ship_ids will be rewritten (owned by this consolidator + carrying the old prefix).
  select count(*) into v_count
    from shipments where forwarder_prefix = v_old and ship_id like v_old || '%';

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

  -- paper trail.
  insert into consolidator_rename_log (old_prefix, new_prefix, ship_ids_touched, renamed_by)
  values (v_old, v_new, v_count, lower(auth.jwt() ->> 'email'));

  return v_count;
end;
$$;

revoke all on function public.rename_consolidator_prefix(text, text) from public, anon;
grant execute on function public.rename_consolidator_prefix(text, text) to authenticated, service_role;
