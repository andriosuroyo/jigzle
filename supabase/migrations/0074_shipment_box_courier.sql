-- PR261 — per-box local courier for an import shipment's boxes.
-- The box editor (Purchasing → History → shipment detail) previously captured only a box tracking
-- number; add the domestic courier alongside it (two fields: local courier + tracking), mirroring the
-- item-level "local courier & tracking". Additive + idempotent; getShipmentBoxes degrades to [] until
-- this is applied (so the screen still renders). real_weight is unchanged (kg).

alter table public.shipment_boxes add column if not exists courier text; -- China-domestic box courier (e.g. ZTO)
