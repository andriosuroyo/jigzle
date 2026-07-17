-- 0097 — PR368: link each managed Sub type to a Product type (Settings › Catalog › Sub types).
-- The Catalog item editor's Sub type picker then offers only the sub-types belonging to the SELECTED
-- product type; a sub-type with no product type is hidden from that picker entirely.
--
-- Additive & idempotent: a nullable product_type on settings_catalog_sub_types, then a one-time
-- backfill from the catalogue's own data — each sub-type adopts the product_type it most often appears
-- with. Only NULL rows are filled, so re-running (or later manual edits) are preserved.
-- Verify after applying:
--   select label, product_type from settings_catalog_sub_types where user_id is null order by product_type, label;

alter table public.settings_catalog_sub_types
  add column if not exists product_type text;

update public.settings_catalog_sub_types s
set product_type = m.pt
from (
  select btrim(sub_type) as label,
         mode() within group (order by btrim(product_type)) as pt
  from public.catalogue
  where sub_type is not null and btrim(sub_type) <> ''
    and product_type is not null and btrim(product_type) <> ''
  group by btrim(sub_type)
) m
where s.user_id is null and s.product_type is null and s.label = m.label;
