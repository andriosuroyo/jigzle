-- 0102 — PR373: fast Catalog dropdown options.
-- Opening any SKU used to call getCatalogFieldOptions(), which downloaded the ENTIRE catalogue
-- (~8.7 MB across ~44 paged requests, reading 10 columns from all ~43k rows) into the browser JUST to
-- compute the Specs-tab dropdown distinct values. That full-table scan was the main reason the
-- item-detail view felt slow, while search (an indexed RPC returning ~21 KB) stayed fast.
--
-- This RPC does the DISTINCT server-side and returns only the small value sets (a few KB) in one call,
-- keyed by field name. The app still unions the Settings-managed classification lists and falls back to
-- the old client-side scan if this function isn't present yet, so it degrades gracefully.
--
-- Idempotent: create-or-replace + re-grant. Safe to re-run.

create or replace function public.catalog_field_options()
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_object_agg(f, arr), '{}'::jsonb)
  from (
    select f, jsonb_agg(distinct v order by v) as arr
    from (
      select 'product_type' as f, btrim(product_type) as v from public.catalogue where btrim(coalesce(product_type, '')) <> ''
      union all select 'sub_type',   btrim(sub_type)   from public.catalogue where btrim(coalesce(sub_type, ''))   <> ''
      union all select 'piece_type', btrim(piece_type) from public.catalogue where btrim(coalesce(piece_type, '')) <> ''
      union all select 'piece_size', btrim(piece_size) from public.catalogue where btrim(coalesce(piece_size, '')) <> ''
      union all select 'material',   btrim(material)   from public.catalogue where btrim(coalesce(material, ''))   <> ''
      union all select 'effect',     btrim(effect)     from public.catalogue where btrim(coalesce(effect, ''))     <> ''
      union all select 'image_type', btrim(image_type) from public.catalogue where btrim(coalesce(image_type, '')) <> ''
      union all select 'theme',      btrim(theme)      from public.catalogue where btrim(coalesce(theme, ''))      <> ''
      union all select 'location',   btrim(location)   from public.catalogue where btrim(coalesce(location, ''))   <> ''
      union all select 'artist',     btrim(artist)     from public.catalogue where btrim(coalesce(artist, ''))     <> ''
    ) s
    group by f
  ) t;
$$;

grant execute on function public.catalog_field_options() to anon, authenticated;
