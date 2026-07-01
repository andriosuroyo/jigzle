-- Forwarders as first-class, Settings-managed rows (like suppliers) — PR123.
-- The To-ship group panel no longer has an inline "+ add forwarder"; forwarders are curated in
-- Settings → Forwarders, each with a leading flag (country derived from it, mirroring suppliers) and
-- a manual sort order. Soft-delete (is_active) keeps historical shipments' forwarder_prefix resolvable
-- while dropping a retired forwarder from the pickers. All columns are additive + defaulted, so
-- existing rows and the existing add/group flows keep working.

alter table public.forwarders
  add column if not exists flag       text,
  add column if not exists sort_order integer not null default 0,
  add column if not exists is_active  boolean not null default true;

-- seed a stable initial order (alphabetical by prefix) for the rows that predate sort_order.
with ordered as (
  select prefix, (row_number() over (order by prefix)) - 1 as rn
  from public.forwarders
)
update public.forwarders f
   set sort_order = ordered.rn
  from ordered
 where ordered.prefix = f.prefix
   and f.sort_order = 0;
