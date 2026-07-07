-- PR211 — estimated weight for SKUs missing a real weight.
-- Cardboard base: est = 240 + 0.8 * piece_count * size_mult * material_mult, rounded to grams.
--   size_mult (from piece_size band): micro .7, tiny .8, small .9, standard 1.0, large 1.2, jumbo 1.5
--   material_mult: wood(en) 1.5, plastic/crystal .8, cork .6, foam .4, else (cardboard/paper/blank) 1.0
-- e.g. a standard 1000-pc puzzle → 240 + 0.8*1000*1*1 = 1040 g. Recomputed in-app on every SKU save;
-- offered as a one-click fill in Catalog → Fix for SKUs with no real_weight. Idempotent / re-runnable.

alter table public.catalogue add column if not exists est_weight numeric;

update public.catalogue set est_weight = round(
  240 + 0.8 * piece_count_n
  * (case lower(coalesce(piece_size, ''))
       when 'micro' then 0.7 when 'tiny' then 0.8 when 'small' then 0.9
       when 'large' then 1.2 when 'jumbo' then 1.5 else 1.0 end)
  * (case
       when material ilike '%wood%'    then 1.5
       when material ilike '%plastic%' then 0.8
       when material ilike '%crystal%' then 0.8
       when material ilike '%cork%'    then 0.6
       when material ilike '%foam%'    then 0.4
       else 1.0 end)
)
where piece_count_n is not null and piece_count_n > 0;
