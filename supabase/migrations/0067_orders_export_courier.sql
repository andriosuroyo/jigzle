-- 0067 — orders.export_courier (PR192): the chosen EXPORT courier for an international order, stamped
-- at Fulfill when the ship-to address is outside Indonesia (negara <> 'Indonesia'). Holds the courier
-- label from settings_export_couriers (0066) — e.g. 'Repack', 'DHL'. NULL for every domestic order.
-- Additive + idempotent; no backfill (existing domestic orders stay NULL).
alter table public.orders add column if not exists export_courier text;
