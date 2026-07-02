-- Warehouse staff (Inbound + Outbound). Adds a staff pick-list (managed in Settings, same shape as the
-- other settings lists) and a `staff` stamp on the two warehouse write paths so History can show WHO
-- received / shipped each record. The active staff is chosen in the Inbound/Outbound header (client-side,
-- per device) and passed into recordReceipt / recordShipment, which stamp it onto the rows.
--
-- No RPC changes: record_receipt (0023) and record_shipment (0035) are left untouched — the app stamps
-- staff with a targeted follow-up UPDATE (inbound by receipt_id, outbound_shipments by order_line_id),
-- keeping this migration small and the big functions stable.
--
-- Idempotent / re-runnable (if not exists / repeatable policy).

-- ============== 1. settings_staff (the pick-list) — mirrors settings_inbound_labels (0031) ==============
create table if not exists public.settings_staff (
  id          bigint generated always as identity primary key,
  user_id     text,                          -- NULL = global default (this app writes only NULL)
  label       text    not null,              -- the staff name, e.g. 'Irene'
  icon        text,                          -- optional emoji / uploaded avatar url (settings-icons)
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists settings_staff_user_sort_idx on public.settings_staff (user_id, sort_order);

alter table public.settings_staff enable row level security;

drop policy if exists "settings_staff_all" on public.settings_staff;
create policy "settings_staff_all" on public.settings_staff
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

-- ============== 2. staff stamp on the two warehouse write paths ==============
alter table public.inbound             add column if not exists staff text;
alter table public.outbound_shipments  add column if not exists staff text;
