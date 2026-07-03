-- PR151 — Settings: local (domestic, supplier-side) couriers as their own pick-list, SEPARATE from
-- settings_courier_services (the OUTBOUND shipping couriers Fulfill uses, which are mandatory at
-- send time). Purchasing → To forwarder's "Local courier & tracking (optional)" reads this list for
-- its suggestions; the field stays free-text so a one-off courier never blocks a save.
-- Seeded with the codebase's previously hard-wired METHODS list. Same house pattern as 0028/0052:
-- global rows (user_id null), RLS via is_allowed_user(), (user_id, sort_order) index.

create table if not exists public.settings_local_couriers (
  id          bigint generated always as identity primary key,
  user_id     text,                          -- NULL = global default
  label       text    not null,              -- 'EMS', 'ZTO', 'SF', …
  icon        text,
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists settings_local_couriers_user_sort_idx on public.settings_local_couriers (user_id, sort_order);

alter table public.settings_local_couriers enable row level security;
drop policy if exists "settings_local_couriers_all" on public.settings_local_couriers;
create policy "settings_local_couriers_all" on public.settings_local_couriers
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());
grant select, insert, update, delete on public.settings_local_couriers to authenticated, service_role;

-- seed once (skip if any global row already exists — re-runnable)
insert into public.settings_local_couriers (user_id, label, sort_order)
select null, v.label, v.ord
from (values
  ('EMS', 0), ('ZTO', 1), ('SF', 2), ('YTO', 3), ('STO', 4),
  ('JD', 5), ('Yunda', 6), ('Best', 7), ('China Post', 8)
) as v(label, ord)
where not exists (
  select 1 from public.settings_local_couriers c where c.user_id is null
);
