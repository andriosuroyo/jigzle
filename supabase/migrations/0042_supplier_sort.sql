-- PR88 — Suppliers settings: manual ordering (up/down) like the other settings lists. Adds a
-- sort_order column, seeded from the current alphabetical-by-name listing so existing rows keep a
-- stable order. getSuppliers now reads by sort_order (then name); a "Sort A–Z" button re-seeds it.

alter table public.suppliers add column if not exists sort_order int not null default 0;

-- seed initial order = alphabetical by name (only touches the still-default rows, so it's a no-op on re-run)
with ordered as (
  select supplier_id, (row_number() over (order by name) - 1) as rn
  from public.suppliers
)
update public.suppliers s
set sort_order = o.rn
from ordered o
where o.supplier_id = s.supplier_id and s.sort_order = 0;

create index if not exists suppliers_sort_idx on public.suppliers (sort_order, name);
