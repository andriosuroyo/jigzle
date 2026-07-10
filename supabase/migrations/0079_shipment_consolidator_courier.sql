-- PR274 — the consolidator COURIER (Consolidator → Shipper leg), pairing with consolidator_tracking (0078).
--
-- Each leg of Item → Consolidator → Shipper → Jigzle now records a courier + a tracking number:
--   • local leg      : purchase_orders.method + tracking_to_forwarder
--   • consolidator leg: shipments.consolidator_courier (this column) + consolidator_tracking (0078)
--   • shipper leg     : shipments.courier + tracking
-- The consolidator courier is picked from the SAME domestic list as the local courier (Settings →
-- "Local & consolidator couriers"); the shipper courier uses the separate "Shipper couriers" list.
-- Nullable, no default; loaders read it in a degrade-to-empty query. Idempotent.

alter table public.shipments add column if not exists consolidator_courier text;
