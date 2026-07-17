-- 0099 — PR371: Catalog sub-type cleanup, from the four-CSV audit.
-- (1) Bless the two legitimate cross-product combos the one-to-one backfill (0097) couldn't represent.
-- (2) Normalize product-type / sub-type typos in the catalogue and retire the now-dead Settings rows.
-- The remaining judgment cases (1-off mis-entries, the "Jixelz" brand line) are left to the new Fix
-- "Sub type ≠ product type" list to surface for a human. Idempotent — safe to re-run.

-- ── (1) missing many-to-many combos: add a second Settings row (same label, other product type) ──
-- Kids Puzzle also appears under 3D Puzzle (98 SKUs); Keychain Puzzle also under Jigsaw Puzzle (3).
insert into public.settings_catalog_sub_types (user_id, label, product_type, is_active, sort_order)
select null, v.label, v.pt, true,
       (select coalesce(max(sort_order), -1) from public.settings_catalog_sub_types where user_id is null)
       + row_number() over ()
from (values
  ('Kids Puzzle', '3D Puzzle'),
  ('Keychain Puzzle', 'Jigsaw Puzzle')
) as v(label, pt)
where not exists (
  select 1 from public.settings_catalog_sub_types s
  where s.user_id is null and s.label = v.label and s.product_type is not distinct from v.pt
);

-- ── (2a) product-type typo: "JIgsaw Puzzle" (capital I) → "Jigsaw Puzzle" (1 SKU) ──
update public.catalogue set product_type = 'Jigsaw Puzzle' where product_type = 'JIgsaw Puzzle';

-- ── (2b) sub-type typo / near-duplicate merges in the catalogue ──
update public.catalogue set sub_type = 'Wood Craft'            where sub_type = 'Wood Crafts';
update public.catalogue set sub_type = 'Puzzle Board + Bracket' where sub_type in ('Puzzle Board Bracket', 'Puzzle Board Set');
update public.catalogue set sub_type = 'Table Clock Puzzle'    where sub_type = 'Wall clock Puzzle'; -- 3D functional clock

-- ── (2c) "Wooden" describes MATERIAL, not a form — move it to the material field, clear the sub type ──
update public.catalogue set material = 'Wood' where sub_type = 'Wooden' and (material is null or btrim(material) = '');
update public.catalogue set sub_type = null   where sub_type = 'Wooden';

-- ── (2d) retire the now-dead / product-type-shaped Settings sub-type rows (soft delete = is_active off) ──
update public.settings_catalog_sub_types set is_active = false
where user_id is null and label in ('Wood Crafts', 'Puzzle Board Bracket', 'Puzzle Board Set', 'Wall clock Puzzle', 'Wooden');
-- "Board Game" is itself a product type — retire it as an Accessories sub type so its SKUs surface in Fix.
update public.settings_catalog_sub_types set is_active = false
where user_id is null and label = 'Board Game' and product_type = 'Accessories';
