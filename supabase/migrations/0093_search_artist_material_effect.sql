-- 0093 — PR348: also search artist, material and effect (further-ideas #1 + #2).
-- #1 artist  — 10,515 rows name an artist ("Thomas Kinkade", "Voila Arts", "芳岡ひでき"); let a query
--    resolve their works. #2 material/effect — 8,660 / 2,369 rows carry a material ("Wood", "Plastic")
--    or effect ("Glow in the dark", "Silhouette"); let "wooden"/"glow" style queries hit them. Adds the
--    three columns as ILIKE branches to both search_skus and search_catalogue (seed + per-token), plus a
--    trgm GIN on each so an artist/material/effect-only query stays index-eligible.
--
-- Pattern unchanged from 0091: bare columns + `(OR) IS NOT TRUE` (null-safe AND index-eligible). Fuzzy
-- stays on translate_name only (names are the fuzzy-worthy field; attributes are exact/substring).
-- Idempotent; self-checks both functions. Verify:
--   select * from search_catalogue('kinkade') limit 5;      -- Thomas Kinkade works
--   select * from search_catalogue('glow') limit 5;         -- Glow-in-the-dark items

begin;

create index if not exists catalogue_artist_trgm_idx   on public.catalogue using gin (artist   gin_trgm_ops);
create index if not exists catalogue_material_trgm_idx on public.catalogue using gin (material gin_trgm_ops);
create index if not exists catalogue_effect_trgm_idx   on public.catalogue using gin (effect   gin_trgm_ops);

drop function if exists public.search_skus(text);
create or replace function public.search_skus(p_q text)
returns table(item_code text, name text, available int, on_the_way int)
language sql stable security invoker set search_path = public as $$
  with toks as (
    select array_agg(t order by ord) as arr, count(*)::int as n
    from (
      select t, ord
      from unnest(regexp_split_to_array(btrim(coalesce(p_q, '')), '\s+')) with ordinality as u(t, ord)
      where length(t) >= 3
    ) s
  ),
  matched as (
    select c.item_code,
           coalesce(nullif(c.translate_name, ''), nullif(c.original_name, ''),
                    nullif(c.self_code, ''), c.item_code) as name
    from catalogue c
    left join brands b on b.prefix = c.brand_prefix,
         toks
    where toks.n > 0
      and (c.item_code ilike '%' || toks.arr[1] || '%'
        or c.translate_name ilike '%' || toks.arr[1] || '%'
        or toks.arr[1] <% c.translate_name
        or c.original_name ilike '%' || toks.arr[1] || '%'
        or c.tags ilike '%' || toks.arr[1] || '%'
        or c.artist ilike '%' || toks.arr[1] || '%'
        or c.material ilike '%' || toks.arr[1] || '%'
        or c.effect ilike '%' || toks.arr[1] || '%'
        or b.name ilike '%' || toks.arr[1] || '%')
      and not exists (
        select 1 from unnest(toks.arr) as t
        where (
             c.item_code ilike '%' || t || '%'
          or c.translate_name ilike '%' || t || '%'
          or t <% c.translate_name
          or c.original_name ilike '%' || t || '%'
          or c.tags ilike '%' || t || '%'
          or c.artist ilike '%' || t || '%'
          or c.material ilike '%' || t || '%'
          or c.effect ilike '%' || t || '%'
          or b.name ilike '%' || t || '%'
          or c.brand_prefix ilike '%' || t || '%'
          or c.piece_count_n::text = t
          or exists (select 1 from search_aliases a
                     where lower(a.term) = lower(t)
                       and (c.item_code ilike '%' || a.alias || '%'
                         or c.translate_name ilike '%' || a.alias || '%'
                         or c.original_name ilike '%' || a.alias || '%'
                         or c.tags ilike '%' || a.alias || '%'
                         or b.name ilike '%' || a.alias || '%'))
        ) is not true
      )
  )
  select m.item_code, m.name,
         coalesce(s.available, 0)::int  as available,
         coalesce(s.on_the_way, 0)::int as on_the_way
  from matched m
  left join stock_snapshot s on s.item_code = m.item_code
  order by (lower(m.item_code) = lower(btrim(coalesce(p_q, '')))) desc, m.item_code
  limit 20;
$$;
revoke all on function public.search_skus(text) from public, anon;
grant execute on function public.search_skus(text) to authenticated, service_role;

drop function if exists public.search_catalogue(text);
create or replace function public.search_catalogue(p_q text)
returns table(item_code text, name text, brand_prefix text, needs_review boolean)
language sql stable security invoker set search_path = public as $$
  with toks as (
    select array_agg(t order by ord) as arr, count(*)::int as n
    from (
      select t, ord
      from unnest(regexp_split_to_array(btrim(coalesce(p_q, '')), '\s+')) with ordinality as u(t, ord)
      where length(t) >= 2
    ) s
  ),
  matched as (
    select c.item_code,
           coalesce(nullif(c.translate_name, ''), nullif(c.original_name, ''),
                    nullif(c.self_code, ''), c.item_code) as name,
           c.brand_prefix, c.needs_review
    from catalogue c
    left join brands b on b.prefix = c.brand_prefix,
         toks
    where toks.n > 0
      and (c.item_code ilike '%' || toks.arr[1] || '%'
        or c.self_code ilike '%' || toks.arr[1] || '%'
        or c.translate_name ilike '%' || toks.arr[1] || '%'
        or (length(toks.arr[1]) >= 3 and toks.arr[1] <% c.translate_name)
        or c.original_name ilike '%' || toks.arr[1] || '%'
        or c.tags ilike '%' || toks.arr[1] || '%'
        or c.artist ilike '%' || toks.arr[1] || '%'
        or c.material ilike '%' || toks.arr[1] || '%'
        or c.effect ilike '%' || toks.arr[1] || '%'
        or b.name ilike '%' || toks.arr[1] || '%')
      and not exists (
        select 1 from unnest(toks.arr) as t
        where (
             c.item_code ilike '%' || t || '%'
          or c.self_code ilike '%' || t || '%'
          or c.translate_name ilike '%' || t || '%'
          or (length(t) >= 3 and t <% c.translate_name)
          or c.original_name ilike '%' || t || '%'
          or c.tags ilike '%' || t || '%'
          or c.artist ilike '%' || t || '%'
          or c.material ilike '%' || t || '%'
          or c.effect ilike '%' || t || '%'
          or b.name ilike '%' || t || '%'
          or c.brand_prefix ilike '%' || t || '%'
          or c.piece_count_n::text = t
          or exists (select 1 from barcodes bc
                     where bc.item_code = c.item_code and bc.barcode ilike '%' || t || '%')
          or exists (select 1 from search_aliases a
                     where lower(a.term) = lower(t)
                       and (c.item_code ilike '%' || a.alias || '%'
                         or c.translate_name ilike '%' || a.alias || '%'
                         or c.original_name ilike '%' || a.alias || '%'
                         or c.tags ilike '%' || a.alias || '%'
                         or b.name ilike '%' || a.alias || '%'))
        ) is not true
      )
  )
  select m.item_code, m.name, m.brand_prefix, m.needs_review
  from matched m
  order by (lower(m.item_code) = lower(btrim(coalesce(p_q, '')))) desc, m.item_code
  limit 200;
$$;
revoke all on function public.search_catalogue(text) from public, anon;
grant execute on function public.search_catalogue(text) to authenticated, service_role;

do $$
begin
  if (select count(*) from public.search_skus('snoopy zzqxnotreal')) <> 0 then
    raise exception 'search_skus strict-AND check FAILED (got % rows)',
      (select count(*) from public.search_skus('snoopy zzqxnotreal'));
  end if;
  if (select count(*) from public.search_catalogue('snoopy zzqxnotreal')) <> 0 then
    raise exception 'search_catalogue strict-AND check FAILED (got % rows)',
      (select count(*) from public.search_catalogue('snoopy zzqxnotreal'));
  end if;
end $$;

commit;
