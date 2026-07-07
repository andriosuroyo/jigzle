-- PR217 — allow up to 8 source links per SKU (was 0..6 = 7). The Catalog editor's Links → Sources
-- section exposes 8 slots; the Purchasing "Buy" overlay reads these (getSkuSources). Idempotent.

-- Drop the existing source_index CHECK by its real name (inline column checks are auto-named), then
-- re-add it allowing 0..7. The DO block finds whatever the constraint is called so this is robust.
do $$
declare c text;
begin
  select conname into c
  from pg_constraint
  where conrelid = 'public.sku_sources'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%source_index%';
  if c is not null then execute format('alter table public.sku_sources drop constraint %I', c); end if;
end $$;

alter table public.sku_sources add constraint sku_sources_source_index_check
  check (source_index between 0 and 7);
