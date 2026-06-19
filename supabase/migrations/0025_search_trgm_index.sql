-- PR19 — pg_trgm GIN indexes for the leading-wildcard ILIKE search paths.
--
-- The SKU add-search (`searchSkus`, stock-check) and the Catalog search (`searchCatalogue`) both run
-- `column ILIKE '%term%'` across the catalogue text columns and the barcode lookup. A leading wildcard
-- defeats a btree, so today those are sequential scans over ~47k catalogue / ~250k barcode rows. A
-- pg_trgm GIN index lets the planner serve `%term%` ILIKE with a bitmap index scan instead.
--
-- Additive + idempotent: the extension and every index are IF NOT EXISTS; NO column/table/RPC/app
-- change. The existing ILIKE/.or() queries pick the indexes up automatically (no code change). PR18's
-- search-speed swap (searchSkus → stock_snapshot matview) removed the per-call view aggregation; this
-- addresses the remaining cost — the leading-wildcard scan itself.
--
-- BUILD LOCK: these are NON-CONCURRENT CREATE INDEX statements — a brief (seconds-long, at current
-- volumes) lock that blocks writes to the table while each index builds; reads are unaffected. On a
-- single-operator system a one-time apply during a quiet moment is fine. To avoid the lock entirely,
-- build them by hand with CREATE INDEX CONCURRENTLY (which cannot run inside a migration transaction)
-- instead of applying this file — the index names below are the ones the app/EXPLAIN will expect.

create extension if not exists pg_trgm;

-- catalogue text columns searched by searchSkus / searchCatalogue (item_code is the PK, but its btree
-- can't serve a leading-wildcard ILIKE — the trigram index can).
create index if not exists catalogue_item_code_trgm_idx      on public.catalogue using gin (item_code gin_trgm_ops);
create index if not exists catalogue_self_code_trgm_idx      on public.catalogue using gin (self_code gin_trgm_ops);
create index if not exists catalogue_original_name_trgm_idx  on public.catalogue using gin (original_name gin_trgm_ops);
create index if not exists catalogue_translate_name_trgm_idx on public.catalogue using gin (translate_name gin_trgm_ops);

-- barcode lookup (`barcode ILIKE '%term%'`) in both search paths.
create index if not exists barcodes_barcode_trgm_idx         on public.barcodes  using gin (barcode gin_trgm_ops);
