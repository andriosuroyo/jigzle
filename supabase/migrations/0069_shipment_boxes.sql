-- PR206 — per-box dimensions/weight/tracking for an import shipment.
-- Captured in Purchasing → History → shipment detail (optional), and pre-fills the Doc Generator CN
-- Packing List for that ship_id. A shipment has 0..N boxes. Idempotent / re-runnable.

create table if not exists public.shipment_boxes (
  id          bigint generated always as identity primary key,
  ship_id     text not null references public.shipments(ship_id) on delete cascade,
  dim_p       numeric,                    -- length (cm)
  dim_l       numeric,                    -- width (cm)
  dim_t       numeric,                    -- height (cm)
  real_weight numeric,                    -- kg
  tracking    text,                       -- China-domestic box tracking (e.g. ZTO …)
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists shipment_boxes_ship_idx on public.shipment_boxes (ship_id, sort_order);

alter table public.shipment_boxes enable row level security;
drop policy if exists "shipment_boxes_all" on public.shipment_boxes;
create policy "shipment_boxes_all" on public.shipment_boxes
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());
grant select, insert, update, delete on public.shipment_boxes to authenticated, service_role;
