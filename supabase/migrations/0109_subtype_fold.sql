-- 0109 — Catalog Sub-type folds: consolidate two labels that lived under multiple product types into
-- their canonical (dominant) product type, then retire the redundant Settings rows (soft delete).
-- Idempotent — safe to re-run. Sub-type usage is a (product_type, sub_type) pair, so folding a label
-- means repointing the catalogue rows' product_type; the sub_type text is unchanged.
--
-- Reviewed but deliberately LEFT as-is: Kids Puzzle (Jigsaw Puzzle 3092 + 3D Puzzle 98 — an intentional
-- many-to-many from 0099), Music Box Puzzle (Mini Block 1), Photo Frame Puzzle (Crafts 1).
-- Verify after applying:
--   select product_type, sub_type, count(*) from public.catalogue
--   where sub_type in ('Card Game','Keychain Puzzle') group by 1,2 order by 2,1;

-- (1) Card Game: Accessories → Games (Games is dominant, 68 SKUs; Accessories had 1).
update public.catalogue set product_type = 'Games'
  where product_type = 'Accessories' and sub_type = 'Card Game';

-- (2) Keychain Puzzle: Jigsaw Puzzle + Misc Goods → 3D Puzzle (3D Puzzle dominant, 628 SKUs).
update public.catalogue set product_type = '3D Puzzle'
  where product_type in ('Jigsaw Puzzle', 'Misc Goods') and sub_type = 'Keychain Puzzle';

-- (3) retire the now-redundant Settings sub-type rows (soft delete = is_active off).
update public.settings_catalog_sub_types set is_active = false
  where user_id is null
    and ( (label = 'Card Game'      and product_type = 'Accessories')
       or (label = 'Keychain Puzzle' and product_type in ('Jigsaw Puzzle', 'Misc Goods')) );
