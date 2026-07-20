-- 0116 — Reclassify Effect (PR385). "Effect" had become a junk drawer holding three different axes.
-- Keep Effect = sensory properties only; move ACTIVITY / FORMAT tokens to Tags (the chosen home). Runs
-- AFTER 0114 (effect is already a " + "-joined set of sentence-cased tokens), so it works token-by-token:
--   • scent synonyms  (Fragrant / Smell / Smell me)      → the effect "Scented"  (kept)
--   • activity/format (Activity, Coloring, Find hidden,
--                      Find me, Scan, Calendar, Heart)    → appended to tags, removed from effect
--   • anything else                                        → kept in effect, unchanged
-- Idempotent: it re-derives effect from scratch and only appends tags not already present, so a second
-- run is a no-op (the activity tokens are gone from effect by then). REVIEW the two token lists below
-- before running — extend them if your catalogue has other activity/format values.
-- Verify after applying:
--   select effect, count(*) from public.catalogue where effect is not null group by 1 order by 2 desc;

do $$
declare
  r        record;
  tok      text;
  low      text;
  keep     text[];
  move     text[];
  neweff   text;
  addtags  text;
  newtags  text;
begin
  for r in
    select item_code, effect, tags
      from public.catalogue
     where effect is not null and btrim(effect) <> ''
  loop
    keep := '{}';
    move := '{}';
    foreach tok in array regexp_split_to_array(r.effect, '\s*\+\s*') loop
      tok := btrim(tok);
      continue when tok = '';
      low := lower(tok);
      if low in ('fragrant', 'smell', 'smell me', 'scented') then
        keep := array_append(keep, 'Scented');                 -- scent → the canonical effect
      elsif low in ('activity', 'coloring', 'colouring', 'find hidden', 'find me', 'scan', 'calendar', 'heart') then
        move := array_append(move,                              -- activity/format → tags (folded synonyms)
                  case low when 'find me' then 'find hidden'
                           when 'colouring' then 'coloring'
                           else low end);
      else
        keep := array_append(keep, tok);                       -- a real effect, left as-is
      end if;
    end loop;

    -- rebuild effect: de-dupe + alphabetical (mirrors normalizeEffect); empty → null
    select nullif(string_agg(k, ' + ' order by lower(k)), '')
      into neweff
      from (select distinct unnest(keep) as k) d;

    -- tags to add = moved tokens not already present in tags (case-insensitive)
    select string_agg(m, ', ')
      into addtags
      from (select distinct unnest(move) as m) d
     where lower(m) not in (
       select lower(btrim(t))
         from unnest(regexp_split_to_array(coalesce(r.tags, ''), '\s*,\s*')) t
        where btrim(t) <> ''
     );

    newtags := case
                 when addtags is null or addtags = '' then r.tags
                 when r.tags is null or btrim(r.tags) = '' then addtags
                 else r.tags || ', ' || addtags
               end;

    if r.effect is distinct from neweff or newtags is distinct from r.tags then
      update public.catalogue set effect = neweff, tags = newtags where item_code = r.item_code;
    end if;
  end loop;
end $$;
