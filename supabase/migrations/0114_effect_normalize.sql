-- 0114 — Effect standard (PR384): sentence-case each effect token, split multi-effects on , + / & ,
-- de-dupe, sort alphabetically (case-insensitive), and re-join with " + ". Folds every legacy variant:
--   "Glow in the Dark" / "Glow in The Dark"      → "Glow in the dark"
--   "Glow in the dark, Silhouette"               → "Glow in the dark + Silhouette"
-- Mirrors normalizeEffect() (app/catalog/normalize.ts), which also runs on every save. Idempotent — the
-- `is distinct from` guard means a re-run touches nothing.
-- Verify after applying:
--   select effect, count(*) from public.catalogue where effect is not null group by 1 order by 2 desc;

update public.catalogue c
   set effect = sub.norm
  from (
    select c2.item_code,
           nullif(
             (select string_agg(tok, ' + ' order by lower(tok))
                from (
                  select distinct (upper(left(btrim(t), 1)) || lower(substr(btrim(t), 2))) as tok
                    from unnest(regexp_split_to_array(c2.effect, '\s*[,+/&]\s*')) as t
                   where btrim(t) <> ''
                ) toks),
             ''
           ) as norm
      from public.catalogue c2
     where c2.effect is not null and btrim(c2.effect) <> ''
  ) sub
 where c.item_code = sub.item_code
   and c.effect is distinct from sub.norm;
