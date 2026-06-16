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
