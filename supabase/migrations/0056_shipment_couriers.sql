-- PR153 — Purchasing History: shipment-level courier & tracking.
--   1. shipments.courier — the international courier that carries the forwarder shipment (DHL, MTE…).
--      (shipments.tracking already exists — 0007 — and is reused as the tracking number.)
--   2. settings_shipment_couriers — the courier pick-list, managed in Settings (same house pattern
--      as 0055 local couriers). Seeded with the common carriers.

alter table public.shipments add column if not exists courier text;

create table if not exists public.settings_shipment_couriers (
  id          bigint generated always as identity primary key,
  user_id     text,                          -- NULL = global default
  label       text    not null,              -- 'DHL', 'FedEx', 'UPS', 'MTE', …
  icon        text,
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists settings_shipment_couriers_user_sort_idx on public.settings_shipment_couriers (user_id, sort_order);

alter table public.settings_shipment_couriers enable row level security;
drop policy if exists "settings_shipment_couriers_all" on public.settings_shipment_couriers;
create policy "settings_shipment_couriers_all" on public.settings_shipment_couriers
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());
grant select, insert, update, delete on public.settings_shipment_couriers to authenticated, service_role;

-- seed once (skip if any global row already exists — re-runnable)
insert into public.settings_shipment_couriers (user_id, label, sort_order)
select null, v.label, v.ord
from (values ('DHL', 0), ('FedEx', 1), ('UPS', 2), ('MTE', 3)) as v(label, ord)
where not exists (
  select 1 from public.settings_shipment_couriers c where c.user_id is null
);
