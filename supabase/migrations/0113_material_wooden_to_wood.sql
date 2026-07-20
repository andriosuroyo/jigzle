-- 0113 — Consolidate the "Wooden" material onto the canonical "Wood" (PR383). Two labels meant the
-- same thing; "Wood" wins. After this, "Wooden" has no users, so it drops out of the editor's Material
-- picker (distinct catalogue values) on its own. Idempotent — safe to re-run.
-- Verify after applying:
--   select material, count(*) from public.catalogue
--   where lower(btrim(material)) in ('wood','wooden') group by 1;   -- expect only "Wood"

update public.catalogue
   set material = 'Wood'
 where material is not null
   and lower(btrim(material)) = 'wooden';
