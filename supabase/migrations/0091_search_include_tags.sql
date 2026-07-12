-- 0091 — PR347: search the catalogue `tags` column, and unify both search RPCs on the index-friendly
-- NULL-safety pattern.
--
-- WHY: ~31% of catalogue rows (14,790 / 47,479) carry a rich, comma-separated `tags` string with the
-- franchise / character / theme vocabulary that the NAME often omits — e.g. Clover's Winnie-the-Pooh
-- puzzles are named "Playing with Honey" / "With a Pot of Honey" but tagged "Pooh Bear, Winnie the Pooh,
-- honey, forest, bee…". So "clover pooh 1000" returned nothing: "pooh" lived only in `tags`. Snoopy items
-- are likewise tagged "Peanuts", so tags also satisfy many alias cases for free. Adding a `tags` ILIKE
-- branch (+ a trgm GIN index so it stays index-eligible) is the single highest-impact search win.
--
-- Also: this rewrites search_skus onto the SAME `(OR) IS NOT TRUE` + bare-column null-safety used by
-- search_catalogue (0090). 0089 fixed the NULL-leak with coalesce(col,''), which is correct but wraps the
-- column and bypasses the 0025 trgm GINs; `(OR) IS NOT TRUE` on BARE columns is both null-safe (FALSE and
-- NULL alike count as "no match") AND index-eligible. Behaviour is identical; only the plan improves.
--
-- Idempotent: index if-not-exists; functions drop+create with repeatable revoke/grant; self-checks RAISE
-- (rolling back) if strict-AND regresses. Verify after applying:
--   select * from search_catalogue('clover pooh 1000') limit 5;   -- Clover Winnie-the-Pooh 1000pc (via tags)
--   select count(*) from search_skus('snoopy zzqxnotreal');       -- 0
--   select * from search_skus('pooh') limit 5;                    -- Pooh items via tags

begin;

-- trgm GIN on tags so `tags ILIKE '%term%'` plans as a bitmap index scan (mirrors the 0025 indexes).
create index if not exists catalogue_tags_trgm_idx on public.catalogue using gin (tags gin_trgm_ops);

-- ── search_skus: Sales/Stock SKU search (item_code, name, available, on_the_way). Now with tags. ──
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
        or b.name ilike '%' || toks.arr[1] || '%')
      and not exists (
        select 1 from unnest(toks.arr) as t
        where (
             c.item_code ilike '%' || t || '%'
          or c.translate_name ilike '%' || t || '%'
          or t <% c.translate_name                                 -- (#1) fuzzy
          or c.original_name ilike '%' || t || '%'                 -- (#5) JP/CN original
          or c.tags ilike '%' || t || '%'                          -- (#7) tags
          or b.name ilike '%' || t || '%'
          or c.brand_prefix ilike '%' || t || '%'
          or c.piece_count_n::text = t
          or exists (select 1 from search_aliases a                -- (#3) alias expansions
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

-- ── search_catalogue: Catalog "All" search (item_code, name, brand_prefix, needs_review). Now with tags. ──
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
        or b.name ilike '%' || toks.arr[1] || '%')
      and not exists (
        select 1 from unnest(toks.arr) as t
        where (
             c.item_code ilike '%' || t || '%'
          or c.self_code ilike '%' || t || '%'
          or c.translate_name ilike '%' || t || '%'
          or (length(t) >= 3 and t <% c.translate_name)            -- (#1) fuzzy
          or c.original_name ilike '%' || t || '%'                 -- (#5) JP/CN original
          or c.tags ilike '%' || t || '%'                          -- (#7) tags
          or b.name ilike '%' || t || '%'
          or c.brand_prefix ilike '%' || t || '%'
          or c.piece_count_n::text = t
          or exists (select 1 from barcodes bc                     -- barcode
                     where bc.item_code = c.item_code and bc.barcode ilike '%' || t || '%')
          or exists (select 1 from search_aliases a                -- (#3) alias expansions
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

-- self-checks: strict-AND must still filter a nonsense token to zero in BOTH functions.
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
