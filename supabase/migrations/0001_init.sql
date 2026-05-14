-- Jigzle Calculator schema
-- Single-user: only ALLOWED_USER_EMAIL can read/write.

create extension if not exists pgcrypto;

-- Currencies (lookup + live rate to IDR)
create table if not exists public.currencies (
  code            text primary key,                -- e.g. 'CNY', 'IDR'
  name            text not null,
  rate_to_idr     numeric(18, 6) not null,         -- 1 unit of `code` = N IDR. IDR = 1.
  is_base         boolean not null default false,  -- IDR true
  updated_at      timestamptz not null default now()
);

-- Shipping methods (one row per route)
create table if not exists public.shipping_methods (
  id              text primary key,                -- e.g. 'ship-cn-ups'
  display         text not null,
  source_country  text not null,
  source_currency text not null references public.currencies(code),
  rate_per_kg     numeric(18, 4) not null,
  rate_currency   text not null references public.currencies(code),
  warehouse_fee   numeric(18, 4) not null default 0,
  tax_included    boolean not null default false,
  active          boolean not null default true,
  sort_order      integer not null default 100,
  notes           text default ''
);

-- Saved calculations (full snapshot per the HTML schema)
create table if not exists public.calculations (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  created_at           timestamptz not null default now(),
  sku                  text default '',
  method_id            text not null,
  method_display       text not null,
  source_country       text not null,
  source_currency      text not null,
  rate_currency        text not null,
  shipping_rate        numeric(18, 4) not null,
  warehouse_fee        numeric(18, 4) not null,
  tax_included         boolean not null,
  fx_source            numeric(18, 6) not null,
  fx_rate_ship         numeric(18, 6) not null,
  tax_rate             numeric(8, 4) not null,
  purchase_price       numeric(18, 4) not null,
  local_shipping       numeric(18, 4) not null,
  real_weight_g        numeric(12, 2) not null,
  box_p                numeric(10, 2) not null,
  box_l                numeric(10, 2) not null,
  box_t                numeric(10, 2) not null,
  coefficient          numeric(6, 4) not null,
  marketplace_active   boolean not null,
  marketplace_rate     numeric(6, 4) not null,
  item_cost_idr        numeric(18, 2) not null,
  shipping_cost_idr    numeric(18, 2) not null,
  import_tax_idr       numeric(18, 2) not null,
  marketplace_fee_idr  numeric(18, 2) not null,
  total_cost_idr       numeric(18, 2) not null,
  rec_sale_price       numeric(18, 2) not null,
  low_margin_idr       numeric(18, 2) not null
);

create index if not exists calculations_user_created_idx
  on public.calculations (user_id, created_at desc);

create index if not exists calculations_sku_idx
  on public.calculations (sku);

-- User preferences (persists last-used inputs, like the original localStorage)
create table if not exists public.user_prefs (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  method_id          text default 'ship-cn-ups',
  tax_rate           numeric(8, 4) default 18.25,
  coefficient        numeric(6, 4) default 0.40,
  marketplace_active boolean default false,
  marketplace_rate   numeric(6, 4) default 7.5,
  updated_at         timestamptz not null default now()
);

-- ============== RLS ==============
alter table public.currencies        enable row level security;
alter table public.shipping_methods  enable row level security;
alter table public.calculations      enable row level security;
alter table public.user_prefs        enable row level security;

-- Helper: only the allowed email may access.
-- Set the allowed email as a database setting OR hardcode below.
-- We hardcode here to keep deploy simple. Change if you need to rotate.
create or replace function public.is_allowed_user()
returns boolean
language sql
stable
as $$
  select coalesce(
    (select email from auth.users where id = auth.uid()) = 'andriosuroyo@gmail.com',
    false
  );
$$;

-- currencies + shipping_methods: readable by allowed user; writes via service role only.
drop policy if exists "currencies_read" on public.currencies;
create policy "currencies_read" on public.currencies
  for select using (public.is_allowed_user());

drop policy if exists "shipping_methods_read" on public.shipping_methods;
create policy "shipping_methods_read" on public.shipping_methods
  for select using (public.is_allowed_user());

-- Allow allowed user to update FX rates from the UI (refresh button).
drop policy if exists "currencies_update" on public.currencies;
create policy "currencies_update" on public.currencies
  for update using (public.is_allowed_user()) with check (public.is_allowed_user());

-- calculations: owned by user_id, must be the allowed user.
drop policy if exists "calculations_select" on public.calculations;
create policy "calculations_select" on public.calculations
  for select using (auth.uid() = user_id and public.is_allowed_user());

drop policy if exists "calculations_insert" on public.calculations;
create policy "calculations_insert" on public.calculations
  for insert with check (auth.uid() = user_id and public.is_allowed_user());

drop policy if exists "calculations_delete" on public.calculations;
create policy "calculations_delete" on public.calculations
  for delete using (auth.uid() = user_id and public.is_allowed_user());

-- user_prefs: owned by user_id.
drop policy if exists "user_prefs_select" on public.user_prefs;
create policy "user_prefs_select" on public.user_prefs
  for select using (auth.uid() = user_id and public.is_allowed_user());

drop policy if exists "user_prefs_upsert_insert" on public.user_prefs;
create policy "user_prefs_upsert_insert" on public.user_prefs
  for insert with check (auth.uid() = user_id and public.is_allowed_user());

drop policy if exists "user_prefs_upsert_update" on public.user_prefs;
create policy "user_prefs_upsert_update" on public.user_prefs
  for update using (auth.uid() = user_id and public.is_allowed_user())
                with check (auth.uid() = user_id and public.is_allowed_user());
