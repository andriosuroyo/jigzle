-- PR25 — SETTINGS module: three global, sortable pick-lists the rest of the app reads.
--   settings_payment_methods · settings_courier_services · settings_box_presets
-- Each row carries a nullable user_id (NULL = the global/default row). This PR only ever writes
-- and reads NULL rows; the column exists so a future PR can add a per-user override row with no
-- migration (spec §6). All three are RLS-gated by is_allowed_user() (the *_all convention, 0008).

-- ============== payment methods ==============
-- Carried over from the Sales hardcoded METHODS[] list at build time (OrderEntry.tsx).
create table if not exists public.settings_payment_methods (
  id          bigint generated always as identity primary key,
  user_id     text,                          -- NULL = global default (this PR writes only NULL)
  label       text    not null,              -- e.g. 'BCA', 'Cash', 'QRIS'
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now()
);

-- ============== courier services (courier + speed pair) ==============
-- Stored structured (courier + speed) but shown as one dropdown of labels in PR26, so the
-- /jigzle-outboundcheck skill can reconcile by service later.
create table if not exists public.settings_courier_services (
  id          bigint generated always as identity primary key,
  user_id     text,                          -- NULL = global default
  courier     text    not null,              -- 'TIKI', 'JNE', 'J&T', …
  speed       text,                          -- 'ONS','REG',… NULL = courier has no speed tiers
  label       text    not null,              -- display, e.g. 'TIKI ONS', 'JNE YES', 'J&T'
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now()
);

-- ============== box presets ==============
-- Dims nullable so a preset can be seeded before real dims are known (seeded as filler 1s here,
-- edited in-app later).
create table if not exists public.settings_box_presets (
  id          bigint generated always as identity primary key,
  user_id     text,                          -- NULL = global default
  code        text    not null,              -- 'XS','XM','XL','S2','M2','L2'
  dim_p       numeric,                       -- cm
  dim_l       numeric,
  dim_t       numeric,
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now()
);

-- ── indexes: the (user_id, sort_order) btree serves the NULL-only ordered read path ──
create index if not exists settings_payment_methods_user_sort_idx  on public.settings_payment_methods  (user_id, sort_order);
create index if not exists settings_courier_services_user_sort_idx on public.settings_courier_services (user_id, sort_order);
create index if not exists settings_box_presets_user_sort_idx      on public.settings_box_presets      (user_id, sort_order);

-- ============== RLS ==============
alter table public.settings_payment_methods  enable row level security;
alter table public.settings_courier_services enable row level security;
alter table public.settings_box_presets      enable row level security;

drop policy if exists "settings_payment_methods_all" on public.settings_payment_methods;
create policy "settings_payment_methods_all" on public.settings_payment_methods
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "settings_courier_services_all" on public.settings_courier_services;
create policy "settings_courier_services_all" on public.settings_courier_services
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "settings_box_presets_all" on public.settings_box_presets;
create policy "settings_box_presets_all" on public.settings_box_presets
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

-- ============== seed (global rows, user_id = NULL; idempotent — guarded by NOT EXISTS) ==============
-- Re-running the migration never duplicates: each row is inserted only if no global row with the
-- same natural key already exists (label / label / code respectively).

-- Payment methods — exact carry-over of the Sales METHODS[] list (OrderEntry.tsx), in its order.
insert into public.settings_payment_methods (user_id, label, sort_order)
select null, v.label, v.ord
from (values
  ('BCA',        0),
  ('Shopee',     1),
  ('Tokopedia',  2),
  ('Mandiri',    3),
  ('Deposit',    4),
  ('Website',    5),
  ('Cash',       6),
  ('Socmed',     7)
) as v(label, ord)
where not exists (
  select 1 from public.settings_payment_methods p
  where p.user_id is null and p.label = v.label
);

-- Courier services — couriers already in FulfillBoard/OutboundBoard COURIERS[], TIKI block first
-- (the main courier per the reconciliation skill), with speed tiers where known.
insert into public.settings_courier_services (user_id, courier, speed, label, sort_order)
select null, v.courier, v.speed, v.label, v.ord
from (values
  ('TIKI',          'ONS', 'TIKI ONS',       0),
  ('TIKI',          'REG', 'TIKI REG',       1),
  ('TIKI',          'ECO', 'TIKI ECO',       2),
  ('TIKI',          'TRC', 'TIKI TRC',       3),
  ('JNE',           'YES', 'JNE YES',        4),
  ('JNE',           'REG', 'JNE REG',        5),
  ('JNE',           'OKE', 'JNE OKE',        6),
  ('J&T',           null,  'J&T',            7),
  ('SiCepat',       null,  'SiCepat',        8),
  ('AnterAja',      null,  'AnterAja',       9),
  ('Ninja Xpress',  null,  'Ninja Xpress',  10),
  ('POS Indonesia', null,  'POS Indonesia', 11),
  ('GoSend',        null,  'GoSend',        12),
  ('GrabExpress',   null,  'GrabExpress',   13),
  ('Lion Parcel',   null,  'Lion Parcel',   14),
  ('ID Express',    null,  'ID Express',    15)
) as v(courier, speed, label, ord)
where not exists (
  select 1 from public.settings_courier_services c
  where c.user_id is null and c.label = v.label
);

-- Box presets — six codes with filler dims = 1 (real dims edited in-app later).
insert into public.settings_box_presets (user_id, code, dim_p, dim_l, dim_t, sort_order)
select null, v.code, 1, 1, 1, v.ord
from (values
  ('XS', 0),
  ('XM', 1),
  ('XL', 2),
  ('S2', 3),
  ('M2', 4),
  ('L2', 5)
) as v(code, ord)
where not exists (
  select 1 from public.settings_box_presets b
  where b.user_id is null and b.code = v.code
);
