-- Phase 1 — drop catalogue.region (Decision D3, 2026-06-16).
-- Geography is represented only by brands.country; the catalogue carries no region.
-- region was a plain text column with an INLINE check constraint (not a Postgres
-- enum type), so the check drops automatically with the column — there is no type
-- to drop. The supporting index is dropped first for clarity (it would cascade anyway).
drop index if exists public.catalogue_region_idx;
alter table public.catalogue drop column if exists region;
