-- 0059 — Settings › Catalog › Classification: three managed pick-lists for the catalogue's
-- classification fields — Product type, Sub type, Piece type. Mirror the other settings_* lists
-- (0046 customer_channels): NULL user_id = global default, sort_order, is_active, RLS via
-- is_allowed_user(). The Catalog item editor's Product/Sub/Piece-type comboboxes union these curated
-- values with the catalogue's distinct values, so the list can be curated (retire typo-variants) while
-- nothing typed on a SKU is ever lost. Each list is SEEDED from today's distinct catalogue values,
-- alphabetical. Additive/safe. (PR193)

-- ── product types ──
create table if not exists public.settings_catalog_product_types (
  id          bigint generated always as identity primary key,
  user_id     text,                          -- NULL = global default (this PR writes only NULL)
  label       text    not null,
  icon        text,
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists settings_catalog_product_types_user_sort_idx
  on public.settings_catalog_product_types (user_id, sort_order);
alter table public.settings_catalog_product_types enable row level security;
drop policy if exists "settings_catalog_product_types_all" on public.settings_catalog_product_types;
create policy "settings_catalog_product_types_all" on public.settings_catalog_product_types
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

-- ── sub types ──
create table if not exists public.settings_catalog_sub_types (
  id          bigint generated always as identity primary key,
  user_id     text,
  label       text    not null,
  icon        text,
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists settings_catalog_sub_types_user_sort_idx
  on public.settings_catalog_sub_types (user_id, sort_order);
alter table public.settings_catalog_sub_types enable row level security;
drop policy if exists "settings_catalog_sub_types_all" on public.settings_catalog_sub_types;
create policy "settings_catalog_sub_types_all" on public.settings_catalog_sub_types
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

-- ── piece types ──
create table if not exists public.settings_catalog_piece_types (
  id          bigint generated always as identity primary key,
  user_id     text,
  label       text    not null,
  icon        text,
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists settings_catalog_piece_types_user_sort_idx
  on public.settings_catalog_piece_types (user_id, sort_order);
alter table public.settings_catalog_piece_types enable row level security;
drop policy if exists "settings_catalog_piece_types_all" on public.settings_catalog_piece_types;
create policy "settings_catalog_piece_types_all" on public.settings_catalog_piece_types
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

-- ── seed each from the distinct catalogue values, alphabetical (idempotent — guarded per label) ──
insert into public.settings_catalog_product_types (user_id, label, sort_order)
select null, s.label, (row_number() over (order by s.label) - 1)::int
from (select distinct btrim(product_type) as label from public.catalogue
      where product_type is not null and btrim(product_type) <> '') s
where not exists (select 1 from public.settings_catalog_product_types t
                  where t.user_id is null and t.label = s.label);

insert into public.settings_catalog_sub_types (user_id, label, sort_order)
select null, s.label, (row_number() over (order by s.label) - 1)::int
from (select distinct btrim(sub_type) as label from public.catalogue
      where sub_type is not null and btrim(sub_type) <> '') s
where not exists (select 1 from public.settings_catalog_sub_types t
                  where t.user_id is null and t.label = s.label);

insert into public.settings_catalog_piece_types (user_id, label, sort_order)
select null, s.label, (row_number() over (order by s.label) - 1)::int
from (select distinct btrim(piece_type) as label from public.catalogue
      where piece_type is not null and btrim(piece_type) <> '') s
where not exists (select 1 from public.settings_catalog_piece_types t
                  where t.user_id is null and t.label = s.label);
