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
