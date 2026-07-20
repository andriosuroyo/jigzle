-- 0115 — Settings › Catalog › Effects: a managed, curated pick-list for the SKU editor's Effect field
-- (PR391). Mirrors settings_catalog_product_types (0059): NULL user_id = global default, RLS via
-- is_allowed_user(), sort_order / is_active. Adds a `category` column — the HIDDEN grouping (Visual /
-- Scent / Texture) staff never have to think about, kept for future faceting/analytics. The editor's
-- Effect picker unions these curated labels with the catalogue's distinct values (like the type lists),
-- so nothing typed on a SKU is ever lost while the vocabulary stays curatable.
-- Additive & idempotent — safe to re-run.

create table if not exists public.settings_catalog_effects (
  id          bigint generated always as identity primary key,
  user_id     text,                          -- NULL = global default (this migration writes only NULL)
  label       text    not null,
  category    text,                          -- hidden grouping: Visual / Scent / Texture (see PR391)
  icon        text,
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists settings_catalog_effects_user_sort_idx
  on public.settings_catalog_effects (user_id, sort_order);
alter table public.settings_catalog_effects enable row level security;
drop policy if exists "settings_catalog_effects_all" on public.settings_catalog_effects;
create policy "settings_catalog_effects_all" on public.settings_catalog_effects
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

-- Seed the canonical sensory-effect vocabulary (idempotent — guarded per label). Category is the hidden
-- axis; staff only ever see/pick the label. Activities/formats (Coloring, Find hidden, Calendar, …) are
-- deliberately NOT here — they move to Tags (see 0116).
insert into public.settings_catalog_effects (user_id, label, category, sort_order)
select null, v.label, v.category, v.ord
from (values
  ('Glow in the dark', 'Visual',  0),
  ('Glitter',          'Visual',  1),
  ('Hologram',         'Visual',  2),
  ('Silhouette',       'Visual',  3),
  ('Scented',          'Scent',   4),
  ('Textured',         'Texture', 5)
) as v(label, category, ord)
where not exists (
  select 1 from public.settings_catalog_effects e
  where e.user_id is null and e.label = v.label
);
