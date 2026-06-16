-- apply-0010.sql
-- Paste-ready bundle for the Supabase SQL editor. Drops catalogue.region (Decision
-- D3). SQL is identical to supabase/migrations/0010_drop_region.sql; only this banner
-- is added. Run this BEFORE the data import (the importer refuses a real load while
-- catalogue.region still exists, because region is NOT NULL).

-- ============================================================================
-- 0010_drop_region.sql
-- ============================================================================

-- Phase 1 — drop catalogue.region (Decision D3, 2026-06-16).
-- Geography is represented only by brands.country; the catalogue carries no region.
-- region was a plain text column with an INLINE check constraint (not a Postgres
-- enum type), so the check drops automatically with the column — there is no type
-- to drop. The supporting index is dropped first for clarity (it would cascade anyway).
drop index if exists public.catalogue_region_idx;
alter table public.catalogue drop column if exists region;
