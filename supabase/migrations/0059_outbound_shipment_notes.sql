-- 0059 — editable per-shipment note in Outbound → History (PR190).
-- Lets the operator attach a free-text note to ANY shipment (e.g. the export-courier tracking number
-- that only comes back after the forwarder settles weight/cost). Keyed by the History row's group key
-- (S:<send_id> for app shipments, C:<composite> for legacy CSV rows) so it works for every shipment,
-- not just international ones. Additive; nothing else touched.

create table if not exists public.outbound_shipment_notes (
  ship_key   text primary key,
  note       text,
  updated_at timestamptz not null default now()
);

alter table public.outbound_shipment_notes enable row level security;
drop policy if exists "outbound_shipment_notes_all" on public.outbound_shipment_notes;
create policy "outbound_shipment_notes_all" on public.outbound_shipment_notes
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());
