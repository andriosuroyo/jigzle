-- 0120: per-box DESCRIPTION (品名) on shipment_boxes.
-- Captured in Purchasing → History detail (one row per box, like the CN Packing List) and
-- prefilled into the Doc Generator › CN Packing List packages. Idempotent / safe to re-run.
alter table if exists public.shipment_boxes
  add column if not exists description text;
