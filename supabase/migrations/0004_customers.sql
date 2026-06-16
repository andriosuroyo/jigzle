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
