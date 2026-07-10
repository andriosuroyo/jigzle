-- PR275 — unify the purchasing pick-lists on Flag · Logo · Prefix · Name.
--
-- The Local & Consolidator couriers and Shipper couriers lists were label-only (plus the shared `icon`
-- = logo, which already accepts an emoji or an uploaded image). This adds the two missing columns so
-- both courier lists match the Consolidators (forwarders) shape: a country flag (with derived country,
-- mirroring suppliers/forwarders) and an editable prefix/shorthand. All nullable — existing rows keep
-- working, and getSettings reads them via select(*), so nothing breaks before this is applied. Idempotent.

alter table public.settings_local_couriers    add column if not exists flag    text;
alter table public.settings_local_couriers    add column if not exists country text;
alter table public.settings_local_couriers    add column if not exists prefix  text;

alter table public.settings_shipment_couriers  add column if not exists flag    text;
alter table public.settings_shipment_couriers  add column if not exists country text;
alter table public.settings_shipment_couriers  add column if not exists prefix  text;
