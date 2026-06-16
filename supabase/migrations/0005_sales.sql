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
