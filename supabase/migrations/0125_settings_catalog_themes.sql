-- 0125 — Settings › Catalog › Themes: a managed, curated pick-list for the SKU editor's Theme field
-- (PR406). Mirrors settings_catalog_effects (0115) / settings_catalog_product_types (0059): NULL user_id
-- = global default, RLS via is_allowed_user(), sort_order / is_active. Theme came back to the Specs tab
-- in PR406 (it was dropped from the editor in PR366 as "redundant with Tags", but the column kept being
-- faceted on in Browse and stayed the cleanest single-value subject axis) — this table is what makes the
-- vocabulary curatable instead of free text.
--
-- Seed = every theme the catalogue ALREADY uses (~900 hierarchical paths, "Character / Disney / Frozen"),
-- so nothing that exists on a SKU is missing from the list on day one and every value can be edited or
-- removed from Settings. The editor's picker still unions these labels with the catalogue's distinct
-- values (unionManagedLists), so a value retired here simply drops out as SKUs stop using it.
-- Additive & idempotent — safe to re-run.

create table if not exists public.settings_catalog_themes (
  id          bigint generated always as identity primary key,
  user_id     text,                          -- NULL = global default (this migration writes only NULL)
  label       text    not null,
  icon        text,
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists settings_catalog_themes_user_sort_idx
  on public.settings_catalog_themes (user_id, sort_order);
alter table public.settings_catalog_themes enable row level security;
drop policy if exists "settings_catalog_themes_all" on public.settings_catalog_themes;
create policy "settings_catalog_themes_all" on public.settings_catalog_themes
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

-- Seed from the live catalogue vocabulary, alphabetically (sort_order follows the A–Z order so the
-- Settings list reads sensibly before anyone re-orders it). Guarded per label → re-running only adds
-- themes that appeared since, and never duplicates or resurrects a removed one it already inserted.
insert into public.settings_catalog_themes (user_id, label, sort_order)
select null, v.label, v.ord
from (
  select trim(theme) as label,
         (row_number() over (order by trim(theme)))::int as ord
  from public.catalogue
  where theme is not null and trim(theme) <> ''
  group by trim(theme)
) as v
where not exists (
  select 1 from public.settings_catalog_themes t
  where t.user_id is null and t.label = v.label
);
