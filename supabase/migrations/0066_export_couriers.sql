-- 0066 — Export couriers (PR191): the Settings-managed pick-list for INTERNATIONAL/export shipments
-- (Repack, DHL, FedEx, …), shown in Sales → Fulfill when the ship-to address is outside Indonesia.
-- Same house pattern as 0055/0056 courier lists, plus an OPTIONAL intermediary address: some export
-- couriers (Repack) receive the parcel first at their own address; others (DHL/FedEx, Balikpapan
-- pickup) have none — hence needs_address + the addr_* fields, filled only when needs_address is true.

create table if not exists public.settings_export_couriers (
  id             bigint generated always as identity primary key,
  user_id        text,                          -- NULL = global default
  label          text    not null,              -- 'Repack', 'DHL', 'FedEx', …
  icon           text,
  is_active      boolean not null default true,
  needs_address  boolean not null default false,-- true → this courier has an intermediary address
  addr_recipient text,                           -- the intermediary address (used only when needs_address)
  addr_phone     text,
  addr_text      text,
  sort_order     int     not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists settings_export_couriers_user_sort_idx on public.settings_export_couriers (user_id, sort_order);

alter table public.settings_export_couriers enable row level security;
drop policy if exists "settings_export_couriers_all" on public.settings_export_couriers;
create policy "settings_export_couriers_all" on public.settings_export_couriers
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());
grant select, insert, update, delete on public.settings_export_couriers to authenticated, service_role;

-- seed the common carriers once (re-runnable). Repack needs an address (filled in Settings); the
-- integrators pick up locally, so they start address-less.
insert into public.settings_export_couriers (user_id, label, needs_address, sort_order)
select null, v.label, v.needs, v.ord
from (values ('Repack', true, 0), ('DHL', false, 1), ('FedEx', false, 2), ('UPS', false, 3)) as v(label, needs, ord)
where not exists (select 1 from public.settings_export_couriers c where c.user_id is null);
