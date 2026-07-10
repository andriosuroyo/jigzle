-- PR272 — the consolidator-tracking number (Consolidator → Shipper leg).
--
-- The purchasing route is Item → Consolidator → Shipper → Jigzle, with three tracking numbers:
--   • Item → Consolidator      = "local tracking"        (per-PO: method + tracking_to_forwarder)
--   • Consolidator → Shipper    = "consolidator tracking" (this column — shipment-level)
--   • Shipper → Jigzle          = "shipment tracking"     (shipments.tracking; courier = shipments.courier)
--
-- Captured in Purchasing → Ship → Create shipment and editable in Purchasing → History; also feeds the
-- History search. Nullable, no default; loaders read it in a degrade-to-empty query so History still
-- renders before this is applied. Idempotent.

alter table public.shipments add column if not exists consolidator_tracking text;
