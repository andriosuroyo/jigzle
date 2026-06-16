-- Phase 1 — Pricing + Royalty + Outbound:
--   price_groups + pricing_config + loyalty_exclusions + royalty_rates + royalty_paid
--   + outbound_shipments + boxes.
-- Shipping methods and FX rates already exist in 0001 (shipping_methods, currencies)
-- and are reused for live pricing — they are NOT re-created here.
-- All money is FULL IDR (bigint).

-- ============== price_groups ==============
-- Authored from the documented pricing rule (no faithful source exists). Each band
-- maps a cost range to a coefficient and the five per-status prices.
create table if not exists public.price_groups (
  group_id    bigint generated always as identity primary key,
  price_group text not null,
  cost_low    bigint,                         -- IDR band lower bound
  cost_high   bigint,                         -- IDR band upper bound
  coeff       numeric(6, 4) not null,         -- higher coeff = higher price
  price_new   bigint,
  price_props bigint,
  price_out   bigint,
  price_rare  bigint,
  price_in    bigint
);

-- ============== pricing_config ==============
-- Global pricing rules. Single row enforced by a boolean PK that must be true.
create table if not exists public.pricing_config (
  id                    boolean primary key default true check (id),
  round_up_step_idr     bigint  not null default 50000,   -- round up to nearest 50K
  psychological_add_idr bigint  not null default 45000,   -- +45K so prices end 95K/45K
  rare_keeps_round      boolean not null default true,    -- rare skips the +45K (stays 1200K/1950K)
  marketplace_uplift    numeric not null default 7.5,     -- percent: marketplace price = website x 1.075
  import_tax_rate       numeric not null default 18.25,   -- percent
  vol_divisor           integer not null default 6000,    -- volumetric weight divisor
  updated_at            timestamptz not null default now()
);

insert into public.pricing_config (id) values (true) on conflict (id) do nothing;

-- ============== loyalty_exclusions ==============
-- Items/types excluded from loyalty discount (low margin), keyed by product_type or item_code.
create table if not exists public.loyalty_exclusions (
  id         bigint generated always as identity primary key,
  kind       text not null check (kind in ('product_type', 'item_code')),
  value      text not null,
  created_at timestamptz not null default now(),
  unique (kind, value)
);

-- ============== royalty_rates ==============
-- Partner x piece-size grid. EMPTY for now; populated in phase 2.
create table if not exists public.royalty_rates (
  partner text primary key check (partner in ('Mentol Art', 'Voila Arts')),
  p35     bigint,
  p63     bigint,
  p80     bigint,
  p120    bigint,
  p300    bigint,
  p500    bigint,
  p1000   bigint,
  p1200   bigint
);

-- ============== royalty_paid ==============
-- Royalty payment history (migrates 1:1). royalty_idr is FULL IDR (not '000).
-- Some source paid dates are year-only -> paid_date NULL with paid_date_raw kept.
create table if not exists public.royalty_paid (
  id            bigint generated always as identity primary key,
  line_id       text,                         -- source ENCRYPT (unique line key)
  partner       text default 'Voila Arts',
  item_code     text references public.catalogue(item_code) on update cascade,
  qty           integer not null,
  royalty_idr   bigint not null,              -- FULL IDR
  fulfill_date  date,
  paid_date     date,
  paid_date_raw text,
  created_at    timestamptz not null default now()
);

create index if not exists royalty_paid_item_code_idx on public.royalty_paid (item_code);

-- ============== outbound_shipments ==============
-- Outbound history (one row per SKU, parsed from the packed Item Name). No id is
-- shared with Sales: the Sales<->Outbound reverse match is phase 2. courier is
-- dirty free text. Feeds the monthly TIKI billing check.
create table if not exists public.outbound_shipments (
  shipment_id    bigint generated always as identity primary key,
  customer_id    bigint references public.customers(customer_id),
  customer_ref   text,                        -- raw 'Name (NNNN)'
  ship_date      date,
  recipient_name text,
  item_code      text references public.catalogue(item_code) on update cascade,
  item_code_raw  text,
  qty            integer not null,
  address        text,
  courier        text,                        -- dirty domain -> free text
  weight_gram    numeric,                     -- shipment-level total weight
  processed      boolean,                     -- source col8 flag (meaning TBC)
  created_at     timestamptz not null default now()
);

create index if not exists outbound_shipments_item_code_idx on public.outbound_shipments (item_code);
create index if not exists outbound_shipments_customer_idx   on public.outbound_shipments (customer_id);

-- ============== boxes ==============
-- Per-box volumetric model for NEW shipments (no historical per-box data exists).
-- chargeable_weight = max(real_weight, vol_weight); vol_weight = ceil(p)*ceil(l)*ceil(t)/6000.
-- Both are written by the app/warehouse; chargeable feeds TIKI billing (+300 g/kg rounding).
create table if not exists public.boxes (
  box_id            bigint generated always as identity primary key,
  shipment_id       bigint references public.outbound_shipments(shipment_id) on delete cascade,
  real_weight       numeric,
  dim_p             numeric,
  dim_l             numeric,
  dim_t             numeric,
  bill_by_volume    boolean not null default false,
  vol_weight        numeric,
  chargeable_weight numeric,
  created_at        timestamptz not null default now()
);

create index if not exists boxes_shipment_idx on public.boxes (shipment_id);

-- ============== RLS ==============
alter table public.price_groups        enable row level security;
alter table public.pricing_config      enable row level security;
alter table public.loyalty_exclusions  enable row level security;
alter table public.royalty_rates       enable row level security;
alter table public.royalty_paid        enable row level security;
alter table public.outbound_shipments  enable row level security;
alter table public.boxes               enable row level security;

drop policy if exists "price_groups_all" on public.price_groups;
create policy "price_groups_all" on public.price_groups
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "pricing_config_all" on public.pricing_config;
create policy "pricing_config_all" on public.pricing_config
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "loyalty_exclusions_all" on public.loyalty_exclusions;
create policy "loyalty_exclusions_all" on public.loyalty_exclusions
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "royalty_rates_all" on public.royalty_rates;
create policy "royalty_rates_all" on public.royalty_rates
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "royalty_paid_all" on public.royalty_paid;
create policy "royalty_paid_all" on public.royalty_paid
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "outbound_shipments_all" on public.outbound_shipments;
create policy "outbound_shipments_all" on public.outbound_shipments
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "boxes_all" on public.boxes;
create policy "boxes_all" on public.boxes
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());
