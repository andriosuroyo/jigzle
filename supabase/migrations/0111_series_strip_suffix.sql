-- 0111 — Series standard (PR391): store the BARE line name, never the trailing "Series" / "シリーズ"
-- word. The field is already labelled SERIES, so "100th Anniversary Series" is redundant — this folds
-- it (and any case/spacing variant of the suffix) down to "100th Anniversary", converging suffix-only
-- duplicates onto one value. Idempotent — safe to re-run (a bare value is left untouched).
--
-- The app also normalises on save (updateSku) and on read (the brand-scoped picker), so behaviour is
-- correct before this runs; this cleans the stored history so search / Browse facets see clean values.
-- Verify after applying:
--   select series, count(*) from public.catalogue
--   where series ~* '(シリーズ|series)\s*$' group by 1 order by 2 desc;   -- expect 0 rows

update public.catalogue
   set series = nullif(
                  btrim(
                    -- strip one-or-more trailing "Series"/"シリーズ" tokens (case-insensitive), then
                    -- collapse the whitespace left behind
                    regexp_replace(series, '([[:space:]　]*(シリーズ|[Ss][Ee][Rr][Ii][Ee][Ss]))+[[:space:]　]*$', '', 'g')
                  ),
                  ''
                )
 where series is not null
   and series ~* '(シリーズ|series)[[:space:]　]*$';
