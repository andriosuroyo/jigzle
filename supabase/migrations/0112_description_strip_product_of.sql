-- 0112 — Strip legacy "Product of 「brand」" placeholder descriptions (PR383). The old system wrote
-- 'Product of 「TENYO」' just to keep the description non-empty; going forward an empty description is
-- fine (real copy or nothing). Remove the phrase wherever it appears; if nothing meaningful is left,
-- null the description. Idempotent — safe to re-run (a cleaned row no longer matches).
-- Verify after applying:
--   select count(*) from public.catalogue where description ~ 'Product of[[:space:]　]*「[^」]*」';  -- expect 0

update public.catalogue
   set description = nullif(
                       btrim(regexp_replace(description, 'Product of[[:space:]　]*「[^」]*」', '', 'g')),
                       ''
                     )
 where description ~ 'Product of[[:space:]　]*「[^」]*」';
