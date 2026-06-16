-- apply-phase1.sql
-- Phase-1 operations migrations 0003-0009, concatenated in dependency order for
-- manual application (e.g. the Supabase SQL editor). The SQL is unchanged from the
-- individual files in supabase/migrations/; only the banner headers below are added.
-- 0001/0002 are NOT included (already applied on the remote).


-- ============================================================================
-- 0003_catalogue.sql
-- ============================================================================

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


-- ============================================================================
-- 0004_customers.sql
-- ============================================================================

-- Phase 1 — Customers: customers + customer_addresses.
-- phone (normalized) is the dedup key; one customer -> many addresses.
-- Source: Sales 'Customer Data' (primary) + Customer workbook (enrichment).

-- ============== customers ==============
-- phone is normalized on import (digits only, local 0-leading form) and is the
-- UNIQUE dedup key, but ~14% of rows have no phone -> the uniqueness is a partial
-- index (only where phone is not null) and phone is nullable. channel is heavily
-- polluted free text (926 raw variants) -> store canonical + raw, no CHECK.
-- lifetime_spend / loyalty_tier / to_next_tier are COMPUTED from orders, not stored.
create table if not exists public.customers (
  customer_id  bigint generated always as identity primary key,
  name         text,
  phone        text,                         -- normalized
  phone_raw    text,                         -- original input preserved
  channel      text,                         -- canonical (derived)
  channel_raw  text,                         -- original input preserved
  ig_handle    text,                         -- extracted from 'DM IG (handle)'
  created_at   timestamptz not null default now()
);

create unique index if not exists customers_phone_key on public.customers (phone) where phone is not null;

-- ============== customer_addresses ==============
-- One customer -> many addresses. address_label is the source 'ADDRESS ID' slug
-- kept for import matching (order lines reference an address by that string).
-- The structured columns are parsed from the multi-line raw_address blob.
create table if not exists public.customer_addresses (
  address_id     bigint generated always as identity primary key,
  customer_id    bigint not null references public.customers(customer_id) on delete cascade,
  address_label  text,                       -- source 'ADDRESS ID' slug (import join key)
  raw_address    text,                       -- unparsed multi-line blob
  recipient_name text,
  contact_phone  text,
  street         text,
  kelurahan      text,
  kecamatan      text,
  kota           text,
  provinsi       text,
  negara         text default 'Indonesia',
  kode_pos       text,
  created_at     timestamptz not null default now()
);

create index if not exists customer_addresses_customer_id_idx on public.customer_addresses (customer_id);
create index if not exists customer_addresses_label_idx        on public.customer_addresses (address_label);

-- ============== RLS ==============
alter table public.customers          enable row level security;
alter table public.customer_addresses enable row level security;

drop policy if exists "customers_all" on public.customers;
create policy "customers_all" on public.customers
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "customer_addresses_all" on public.customer_addresses;
create policy "customer_addresses_all" on public.customer_addresses
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());


-- ============================================================================
-- 0005_sales.sql
-- ============================================================================

-- Phase 1 — Sales: orders + order_lines + payments + holds.
-- The interleaved Sales Data (📦-header row + line rows) is split into orders
-- (one per sales_id) and order_lines (line_id = the old "Encrypt").
-- All money is stored in FULL IDR (bigint); Sales '000-IDR values are x1000 on import.
-- Cancelled orders are kept, never deleted.

-- ============== orders ==============
-- One row per header (where SALES ID == ENCRYPT). Source status 'Cancel' is
-- canonicalized to 'Cancelled'. payment_method / payment_status are the order-level
-- summary; the payment ledger lives in payments.
create table if not exists public.orders (
  sales_id        text primary key,          -- source SALES ID
  customer_id     bigint references public.customers(customer_id),
  customer_ref    text,                      -- raw 'Name (NNNN)' when unresolved
  address_id      bigint references public.customer_addresses(address_id),
  order_date      date,
  status          text check (status in ('Need payment', 'Need send', 'Complete', 'Cancelled')),
  sales_total_idr bigint,                    -- FULL IDR (source '000-IDR x1000)
  payment_method  text,                      -- BCA / Shopee / Tokopedia / Mandiri / Deposit / Website / Cash / Socmed
  payment_status  text check (payment_status in ('Paid', 'Unpaid', 'Cancel')),
  order_note      text,
  created_at      timestamptz not null default now()
);

create index if not exists orders_customer_id_idx on public.orders (customer_id);
create index if not exists orders_status_idx       on public.orders (status);

-- ============== order_lines ==============
-- One row per line (where SALES ID != ENCRYPT). line_id (Encrypt) is an opaque,
-- non-uniform TEXT key (some legacy rows embed a customer name) — never parsed.
-- item_code is a nullable FK: legacy lines can carry free-text instead of a SKU.
-- The two-stage stock cut lives here: fulfilled_at = committed (cut #1),
-- shipped_at = physically left the shelf (cut #2). courier / tracking are per line.
create table if not exists public.order_lines (
  line_id          text primary key,         -- the old "Encrypt"
  sales_id         text not null references public.orders(sales_id) on delete cascade,
  item_code        text references public.catalogue(item_code) on update cascade,
  item_code_raw    text,                     -- original cell when item_code unresolved
  qty              integer not null check (qty >= 0),
  item_link        text,
  line_note        text,
  courier          text,                     -- split from the composite courier/tracking cell
  courier_tracking text,
  fulfilled_at     timestamptz,              -- stock cut #1 (committed at Sales Fulfill)
  shipped_at       timestamptz,              -- stock cut #2 (shipped at Outbound)
  is_cancelled     boolean not null default false,
  address_id       bigint references public.customer_addresses(address_id),
  created_at       timestamptz not null default now()
);

create index if not exists order_lines_sales_id_idx  on public.order_lines (sales_id);
create index if not exists order_lines_item_code_idx on public.order_lines (item_code);
-- Stock-view support: fulfilled / shipped quantities per SKU.
create index if not exists order_lines_fulfilled_idx on public.order_lines (item_code) where fulfilled_at is not null and not is_cancelled;
create index if not exists order_lines_shipped_idx   on public.order_lines (item_code) where shipped_at   is not null and not is_cancelled;

-- ============== payments ==============
-- Ledger: many payments per order (DP -> settlement). Derived from the order's
-- NOTES on import (the DP/Full/Lunas prefix + multiline installment lines).
create table if not exists public.payments (
  payment_id  bigint generated always as identity primary key,
  sales_id    text not null references public.orders(sales_id) on delete cascade,
  amount_idr  bigint not null,              -- FULL IDR
  type        text check (type in ('DP', 'Full', 'Settlement')),
  method      text,                          -- BCA / Mandiri / Shopee / ...
  paid_date   date,
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists payments_sales_id_idx on public.payments (sales_id);

-- ============== holds ==============
-- A physical hold-rack reservation that reduces available stock. No order/line
-- keys (pre-order). released_at NULL = active; set on fulfill (auto-release).
-- The customer is parsed from a 'For: <name>' note on import.
create table if not exists public.holds (
  hold_id     bigint generated always as identity primary key,
  item_code   text not null references public.catalogue(item_code) on update cascade,
  qty         integer not null check (qty >= 0),
  customer_id bigint references public.customers(customer_id),
  note        text,
  created_at  timestamptz not null default now(),
  released_at timestamptz
);

create index if not exists holds_active_item_idx on public.holds (item_code) where released_at is null;

-- ============== RLS ==============
alter table public.orders      enable row level security;
alter table public.order_lines enable row level security;
alter table public.payments    enable row level security;
alter table public.holds       enable row level security;

drop policy if exists "orders_all" on public.orders;
create policy "orders_all" on public.orders
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "order_lines_all" on public.order_lines;
create policy "order_lines_all" on public.order_lines
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "payments_all" on public.payments;
create policy "payments_all" on public.payments
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "holds_all" on public.holds;
create policy "holds_all" on public.holds
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());


-- ============================================================================
-- 0006_inbound.sql
-- ============================================================================

-- Phase 1 — Receiving: inbound (the "+" side of stock).
-- Source: Inbound Data + legacy Warehouse Inbound (deduped on import).

-- ============== inbound ==============
-- No native PK in source -> surrogate inbound_id; the legacy serial is kept as
-- legacy_ref. qty is SIGNED: negative rows are stock adjustments/corrections.
--
-- ship_id is a nullable, free-text legacy key and is the join to shipments. Two
-- shapes coexist by design:
--   * forwarder shipments entered into Data Shipment, e.g. 'SUB 191', 'IMA 1023';
--   * the 📦YYMMXXX form (📦 icon + YYMM + a 3-digit counter that restarts at 001
--     each month) for inbound items NOT entered into the shipments Data — the 📦
--     icon intentionally distinguishes these. No hard FK to shipments: many
--     legacy/ad-hoc ship_ids will never exist there.
--
-- excluded (gift/damaged) contributes 0 sellable stock. is_opening_balance marks
-- the "Up to 2023" rows. receive_date is parsed where possible; the raw string is
-- retained ('yyyy.mm', 'Up to 2023', and dirty outliers).
create table if not exists public.inbound (
  inbound_id         bigint generated always as identity primary key,
  item_code          text references public.catalogue(item_code) on update cascade,
  item_code_raw      text,                   -- original cell (TEMP / Bonus / FRAME sentinels won't FK)
  qty                integer not null,       -- signed
  ship_id            text,                   -- nullable legacy join key (see note above)
  receive_date       date,
  receive_date_raw   text,                   -- 'yyyy.mm' / 'Up to 2023' / dirty values preserved
  is_opening_balance boolean not null default false,
  excluded           boolean not null default false,
  label              text check (label in ('Exclude', 'Hold', 'Tokopedia')),
  tracking           text,
  receive_note       text,
  dimension_weight   text,                   -- raw 'L x W x H cm / NNNg'
  transfer_box_id    text,                   -- TP00N transfer box (Tokopedia)
  legacy_ref         text,                   -- Warehouse 'Item ID' receiving serial
  created_at         timestamptz not null default now()
);

create index if not exists inbound_item_code_idx on public.inbound (item_code);
create index if not exists inbound_ship_id_idx    on public.inbound (ship_id);
-- Stock-view support: sellable inbound quantity per SKU.
create index if not exists inbound_sellable_idx   on public.inbound (item_code) where not excluded;

-- ============== RLS ==============
alter table public.inbound enable row level security;

drop policy if exists "inbound_all" on public.inbound;
create policy "inbound_all" on public.inbound
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());


-- ============================================================================
-- 0007_procurement.sql
-- ============================================================================

-- Phase 1 — Procurement: suppliers + forwarders + shipments + purchase_orders + missing_pieces.
-- Open pipeline only; received lines leave to Inbound (matched by ship_id).
-- Source: Order workbook (Order Data / Manage / Unsorted / Manual, Missing Piece Data)
-- + Warehouse Data Shipment.

-- ============== suppliers ==============
-- No dedicated source tab: derived from the distinct ACCOUNT/SUPPLIER strings.
-- country is split from the leading flag emoji; type is inferred (a phone-number
-- name => Taobao account, a nickname => agent).
create table if not exists public.suppliers (
  supplier_id bigint generated always as identity primary key,
  name        text not null unique,
  country     text,
  flag        text,                          -- leading flag emoji preserved
  type        text check (type in ('Taobao account', 'agent', 'marketplace', 'other')),
  created_at  timestamptz not null default now()
);

-- ============== forwarders ==============
-- No source tab: forwarder identity is encoded in the ship_id prefix. The prefix
-- is the natural key; name/country are hand-curated (e.g. LGB = LetsGoBuy).
create table if not exists public.forwarders (
  prefix     text primary key,               -- ship_id prefix: CBL, MTE, SUB, LGB, IMA, ...
  name       text,
  country    text,
  created_at timestamptz not null default now()
);

-- ============== shipments ==============
-- The forwarder shipment ledger. ship_id is the (text) join key used by inbound
-- and purchase_orders. status is open/completed (derived from received_date).
-- Note: inbound.ship_id and purchase_orders.ship_id are intentionally NOT hard
-- FKs to this table (legacy/ad-hoc ship_ids — incl. the 📦YYMMXXX form — won't
-- all be present here).
create table if not exists public.shipments (
  ship_id          text primary key,         -- 'SUB 191', 'IMA 1023'
  forwarder_prefix text references public.forwarders(prefix),
  origin_country   text,                      -- normalized (flag stripped)
  status           text check (status in ('open', 'completed')),
  ship_date        date,
  received_date    date,
  tracking         text,
  contents         jsonb,                     -- [{qty, item}] shipment line-items
  note             text,
  created_at       timestamptz not null default now()
);

create index if not exists shipments_forwarder_idx on public.shipments (forwarder_prefix);

-- ============== purchase_orders ==============
-- The PO line spine. The source "Encrypt" fans out to multiple item lines, so it
-- is NOT unique -> surrogate po_id PK with encrypt kept as a column. 'Received'
-- is permitted though it never appears in the open-pipeline export (received POs
-- are removed there). marketplace_order_id is TEXT (19-digit Taobao ids overflow).
create table if not exists public.purchase_orders (
  po_id                 bigint generated always as identity primary key,
  encrypt               text,
  supplier_id           bigint references public.suppliers(supplier_id),
  item_code             text references public.catalogue(item_code) on update cascade,
  item_code_raw         text,
  qty                   integer not null check (qty >= 0),
  status                text check (status in ('Processing', 'On the way', 'With Forwarder', 'Received')),
  status_since          date,
  item_cost             numeric,             -- supplier-currency unit cost (unit varies by supplier)
  method                text,                -- domestic courier (EMS / ZTO / SF / ...)
  ship_id               text,                -- soft join to shipments (nullable)
  customs_value_usd     numeric,
  tracking_to_wh        text,
  tracking_to_forwarder text,
  tracking_to_jigzle    text,
  marketplace_order_id  text,                -- Taobao order id (订单号)
  customer_id           bigint references public.customers(customer_id),  -- optional: item wanted by a customer
  item_note             text,
  shipment_note         text,
  input_date            date,
  receive_date          date,
  created_at            timestamptz not null default now()
);

create index if not exists purchase_orders_item_code_idx on public.purchase_orders (item_code);
create index if not exists purchase_orders_status_idx     on public.purchase_orders (status);
create index if not exists purchase_orders_ship_id_idx    on public.purchase_orders (ship_id);
create index if not exists purchase_orders_supplier_idx   on public.purchase_orders (supplier_id);
-- Stock-view support: pending / on-the-way quantities per SKU.
create index if not exists purchase_orders_incoming_idx   on public.purchase_orders (item_code, status);

-- ============== missing_pieces ==============
-- Customer-service reorder flow. customer_ref is fuzzy ('Name (id)'); piece_n are
-- 'x / y' coordinate text. sent_date / received_date are mostly placeholders in
-- source -> nullable dates.
create table if not exists public.missing_pieces (
  mp_id          bigint generated always as identity primary key,
  encrypt        text,
  report_date    date,
  customer_id    bigint references public.customers(customer_id),
  customer_ref   text,
  origin_flag    text,
  item_code      text references public.catalogue(item_code) on update cascade,
  card_details   text,
  piece_1        text,
  piece_2        text,
  piece_3        text,
  pic_card_url   text,
  pic_puzzle_url text,
  ship_id        text,
  sent_date      date,
  received_date  date,
  created_at     timestamptz not null default now()
);

create index if not exists missing_pieces_item_code_idx on public.missing_pieces (item_code);
create index if not exists missing_pieces_customer_idx   on public.missing_pieces (customer_id);

-- ============== RLS ==============
alter table public.suppliers       enable row level security;
alter table public.forwarders      enable row level security;
alter table public.shipments       enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.missing_pieces  enable row level security;

drop policy if exists "suppliers_all" on public.suppliers;
create policy "suppliers_all" on public.suppliers
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "forwarders_all" on public.forwarders;
create policy "forwarders_all" on public.forwarders
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "shipments_all" on public.shipments;
create policy "shipments_all" on public.shipments
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "purchase_orders_all" on public.purchase_orders;
create policy "purchase_orders_all" on public.purchase_orders
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "missing_pieces_all" on public.missing_pieces;
create policy "missing_pieces_all" on public.missing_pieces
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());


-- ============================================================================
-- 0008_pricing.sql
-- ============================================================================

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


-- ============================================================================
-- 0009_stock_view.sql
-- ============================================================================

-- Phase 1 — The stock engine: the stock_check view.
-- This view IS the "Stock Check" screen. Stock is computed live, never stored.
--
-- Two-stage stock cut: committed at Sales Fulfill (fulfilled_at), physically leaves
-- at Outbound (shipped_at). Per SKU:
--   available  = Σ inbound(not excluded) − Σ fulfilled − Σ holds(active)
--   physical   = Σ inbound(not excluded) − Σ shipped          (warehouse shelf count)
--   reserved   = Σ fulfilled − Σ shipped                       (the picking queue)
--   pending    = Σ purchase_orders where status = 'Processing'
--   on_the_way = Σ purchase_orders where status in ('On the way','With Forwarder')
--   last_receive = max(inbound.receive_date)
-- Identity check: available + reserved + on_hold = physical, by construction.
--
-- security_invoker = true so the querying user's RLS on the base tables applies
-- (the view does not run with the definer's privileges).
-- History reaches back to 2015 on both sides (inbound carries the opening-balance
-- bucket, sales carries the backup archive), so inbound − sales is valid across all
-- time and no separate baseline is needed.
--
-- Built as a plain view; the base-table partial indexes (created in 0005/0006/0007)
-- support the aggregations. Switch to a materialized view + refresh if the screen
-- becomes slow at ~47k SKUs.

create or replace view public.stock_check
  with (security_invoker = true)
as
with inb as (
  select item_code,
         sum(qty) filter (where not excluded) as inbound_qty,
         max(receive_date)                    as last_receive
  from public.inbound
  where item_code is not null
  group by item_code
),
sales as (
  select item_code,
         sum(qty) filter (where fulfilled_at is not null and not is_cancelled) as fulfilled_qty,
         sum(qty) filter (where shipped_at   is not null and not is_cancelled) as shipped_qty
  from public.order_lines
  where item_code is not null
  group by item_code
),
hld as (
  select item_code,
         sum(qty) as hold_qty
  from public.holds
  where released_at is null
  group by item_code
),
po as (
  select item_code,
         sum(qty) filter (where status = 'Processing')                    as pending_qty,
         sum(qty) filter (where status in ('On the way', 'With Forwarder')) as on_the_way_qty
  from public.purchase_orders
  where item_code is not null
  group by item_code
)
select
  c.item_code,
  coalesce(inb.inbound_qty, 0)   - coalesce(sales.fulfilled_qty, 0) - coalesce(hld.hold_qty, 0) as available,
  coalesce(inb.inbound_qty, 0)   - coalesce(sales.shipped_qty, 0)                               as physical,
  coalesce(sales.fulfilled_qty, 0) - coalesce(sales.shipped_qty, 0)                             as reserved,
  coalesce(hld.hold_qty, 0)      as on_hold,
  coalesce(po.pending_qty, 0)    as pending,
  coalesce(po.on_the_way_qty, 0) as on_the_way,
  inb.last_receive
from public.catalogue c
left join inb   on inb.item_code   = c.item_code
left join sales on sales.item_code = c.item_code
left join hld   on hld.item_code   = c.item_code
left join po    on po.item_code    = c.item_code;
