-- 0103 — PR378: fast Catalog → Browse.
-- Browse used getCatalogFacetData(), which downloaded EVERY catalogue row (12 columns × ~47k rows,
-- ~0.9 MB gzipped, paged) into the browser just to (a) count SKUs per region/country/brand and (b) hold
-- the SKUs for the drill-down. (a) needs only per-brand counts; (b) needs only the SELECTED brand's rows.
--
-- This RPC returns the per-brand counts (≤ ~260 rows) so the whole geography tree renders from a few KB;
-- the app then fetches a single brand's SKUs on demand when you drill in. Brand-less rows (~25) are
-- excluded — they aren't reachable via a brand drill-down anyway. The app falls back to a lightweight
-- client scan if this function isn't present yet, so it degrades gracefully. Idempotent.

create or replace function public.catalog_brand_counts()
returns table (brand_prefix text, n bigint)
language sql
stable
as $$
  select brand_prefix, count(*)::bigint
  from public.catalogue
  where brand_prefix is not null
  group by brand_prefix;
$$;

grant execute on function public.catalog_brand_counts() to anon, authenticated;
