-- 0092 — PR347: seed search_aliases with high-value shorthands the catalogue text/tags don't contain.
-- With 0091 the search now also reads `tags`, which already covers most character / franchise / theme
-- words (searching "pooh", "disney", "honey" etc. now works). Aliases are for the remaining gap:
-- ABBREVIATIONS and NO-SPACE forms that appear NOWHERE in item_code / name / tags, so no amount of
-- fuzzy/tag matching can find them. Each pair below was checked against production — the left term
-- returns ~0 today, the right (canonical) substring has real coverage (shown in the comment).
--
-- One-directional (term → alias): typing the shorthand also matches the canonical text; the reverse is
-- pointless (the canonical already works on its own). Editable/prunable in Settings → Catalog → Search
-- aliases. Idempotent (on conflict do nothing). Terms/aliases lowercase (matched case-insensitively).

begin;

insert into public.search_aliases (term, alias) values
  ('wtp',          'winnie the pooh'),   -- 0 → 379
  ('jjk',          'jujutsu kaisen'),    -- 0 → 28
  ('aot',          'attack on titan'),   -- 18 → 46
  ('dbz',          'dragon ball'),       -- 3 → 141
  ('dragonball',   'dragon ball'),       -- 11 → 141
  ('kny',          'kimetsu'),           -- 3 → 69   (Kimetsu no Yaiba)
  ('demonslayer',  'demon slayer'),      -- 0 → 106
  ('spyfamily',    'spy x family'),      -- 0 → 31
  ('studioghibli', 'studio ghibli'),     -- 0 → 578
  ('pkmn',         'pokemon'),           -- 0 → 426
  ('sailormoon',   'sailor moon'),       -- 1 → 75
  ('onepiece',     'one piece'),         -- 359 → 1241
  ('hellokitty',   'hello kitty'),       -- 286 → 572
  ('toystory',     'toy story'),         -- 123 → 364
  ('starwars',     'star wars')          -- 25 → 211
on conflict do nothing;

commit;
