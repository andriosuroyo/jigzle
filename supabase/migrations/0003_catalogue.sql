-- Phase 1 — Catalogue spine: brands + catalogue + barcodes + sku_sources.
-- item_code is the universal primary key / FK target for the whole operations schema.
-- Source: the 4 regional Catalogue workbooks (~47,458 rows), unioned on import.
-- Conventions follow 0001_init.sql (snake_case, lowercase DDL, RLS via is_allowed_user()).

-- ============== brands ==============
-- Canonical brand list = the 218-prefix lookup in SKU Master (prefix -> name).
-- No brand_id / country exist in source: prefix is the natural key. priority /
-- check_cadence / new_products_url are East-Asia-only enrichment (nullable).
-- Compound Disney sub-brand prefixes (DIS-TDL, DIS-TDS, ...) are kept as-is.
create table if not exists public.brands (
  prefix            text primary key,        -- = catalogue.self_code (trailing '-' stripped on import)
  name              text,                    -- ~8% null (reserved codes)
  country           text,                    -- no source; nullable, infer later
  priority          text,                    -- HIGH/MID/LOW PRIORITY, WORK IN PROGRESS
  check_cadence     text,                    -- CHECK EVERY MONTH/TWO/THREE MONTHS, COMPLETE THE CATALOG
  new_products_url  text,
  created_at        timestamptz not null default now()
);

-- ============== catalogue ==============
-- The spine. item_code is a globally-unique TEXT PK; the handful of dirty raw
-- collisions (PRE-PM1000-001 across regions, plus 2 intra-file dups) are merged
-- at import. brand_prefix is taken from the explicit SELF CODE column, NOT by
-- string-splitting item_code (a few irregular codes do not follow the convention).
-- Derived values size_all, dim_all and vol_weight (= dim_p*dim_l*dim_t/6000) are
-- computed in the app/view, never stored.
create table if not exists public.catalogue (
  item_code        text primary key,
  brand_prefix     text references public.brands(prefix),
  region           text not null check (region in ('Japan', 'East Asia', 'Americas', 'Rest of World')),
  self_code        text,
  original_name    text,                     -- native-language name (CJK / UTF-8)
  translate_name   text,
  description      text,
  product_type     text,                     -- dirty domain -> free text, normalized in app
  sub_type         text,
  piece_count      text,                     -- raw; multipacks hold comma-lists ('35, 20, 12')
  piece_count_n    integer,                  -- parsed primary count where unambiguous
  piece_type       text,
  piece_size       text,                     -- Tiny / Small / Large / Micro / Jumbo
  size_p           numeric,                  -- finished-image dimensions (cm)
  size_l           numeric,
  size_t           numeric,
  dim_p            numeric,                  -- box / shipping dimensions (cm)
  dim_l            numeric,
  dim_t            numeric,
  real_weight      numeric,                  -- box real weight (g)
  material         text,
  effect           text,
  image_type       text,                     -- Panorama / Round / Square
  artist           text,                     -- royalty partner or free text
  tags             text,                     -- comma-separated keywords
  article_number   text,                     -- catalogue article number (barcodes split out separately)
  release_date     text,                     -- partial dates ('yyyy.mm' dominant) -> kept raw
  release_year     smallint,                 -- parsed from release_date
  release_month    smallint,
  theme            text,                     -- Japan workbook only (null elsewhere)
  location         text,                     -- Japan workbook only
  image            text,                     -- image url
  has_image        boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists catalogue_brand_prefix_idx on public.catalogue (brand_prefix);
create index if not exists catalogue_region_idx       on public.catalogue (region);
create index if not exists catalogue_product_type_idx on public.catalogue (product_type);

-- ============== barcodes ==============
-- One SKU -> many barcodes. Each barcode is globally UNIQUE (the PK is the
-- collision guard); the app appends a suffix on a reused barcode. Stored as TEXT
-- to preserve leading zeros (EAN / UPC / JAN, 10-13 digits). is_verified records
-- the source '* black-square' verification marker.
create table if not exists public.barcodes (
  barcode     text primary key,
  item_code   text not null references public.catalogue(item_code) on update cascade,
  is_verified boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists barcodes_item_code_idx on public.barcodes (item_code);

-- ============== sku_sources ==============
-- The old SOURCE 0..6 columns unpivoted: many source URLs per SKU. source_index
-- (0-6) encodes origin / priority order.
create table if not exists public.sku_sources (
  id           bigint generated always as identity primary key,
  item_code    text not null references public.catalogue(item_code) on update cascade,
  source_index smallint not null check (source_index between 0 and 6),
  url          text not null,
  created_at   timestamptz not null default now(),
  unique (item_code, source_index)
);

create index if not exists sku_sources_item_code_idx on public.sku_sources (item_code);

-- ============== RLS ==============
-- Single operator: the allowed user reads and writes all operations data.
alter table public.brands       enable row level security;
alter table public.catalogue    enable row level security;
alter table public.barcodes     enable row level security;
alter table public.sku_sources  enable row level security;

drop policy if exists "brands_all" on public.brands;
create policy "brands_all" on public.brands
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "catalogue_all" on public.catalogue;
create policy "catalogue_all" on public.catalogue
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "barcodes_all" on public.barcodes;
create policy "barcodes_all" on public.barcodes
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "sku_sources_all" on public.sku_sources;
create policy "sku_sources_all" on public.sku_sources
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());
