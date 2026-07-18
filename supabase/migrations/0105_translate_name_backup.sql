-- 0105 — PR386: back up every current translate_name into translate_name_old ONCE, so the in-session
-- name-retranslation pass (which overwrites translate_name for every SKU with an original name) is fully
-- reversible and nothing is lost. The app keeps reading translate_name, unchanged.
-- Verify after applying:
--   select count(*) from catalogue where translate_name_old is not null;   -- ≈ rows with a translation

alter table public.catalogue add column if not exists translate_name_old text;

-- one-time backup: fill translate_name_old only where it's still NULL, so re-running (or a second pass
-- after the retranslation has already overwritten translate_name) never clobbers the preserved originals.
update public.catalogue
set translate_name_old = translate_name
where translate_name_old is null and translate_name is not null;
