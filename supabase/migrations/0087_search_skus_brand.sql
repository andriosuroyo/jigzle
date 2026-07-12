-- 0087 — PR343: extend public.search_skus(p_q) to also match the BRAND (name + prefix), and restore the
-- strict "every token must match somewhere" semantics (the live function had drifted to matching only the
-- first token, so e.g. "snoopy zzqxnotreal" wrongly returned every Snoopy item).
--
-- Token model (unchanged from 0027): p_q is split on whitespace into tokens (each ≥3 chars so the pg_trgm
-- GIN index stays eligible); a SKU matches iff EVERY token matches SOMEWHERE. Per-token a token may match
-- item_code ILIKE, translate_name ILIKE, the brand NAME ILIKE, the brand PREFIX ILIKE, OR an exact
-- piece_count_n. AND across tokens, OR across fields — so word order doesn't matter ("clover snoopy 1000"
-- == "snoopy clover 1000") and a brand token ("clover") now resolves via brands.name even when the item's
-- own name doesn't contain it.
--
-- Idempotent: drop-if-exists + create + repeatable revoke/grant. SECURITY INVOKER keeps the caller's RLS.
-- Verify after applying:
--   select count(*) from search_skus('snoopy zzqxnotreal');       -- expect 0 (strict AND restored)
--   select * from search_skus('clover snoopy 1000') limit 5;      -- Clover-brand Snoopy 1000pc items

begin;

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
      -- seed on the first token (index entry point); mirrors the per-token predicate exactly, incl. brand
      and (c.item_code ilike '%' || toks.arr[1] || '%'
        or c.translate_name ilike '%' || toks.arr[1] || '%'
        or b.name ilike '%' || toks.arr[1] || '%'
        or c.brand_prefix ilike '%' || toks.arr[1] || '%'
        or c.piece_count_n::text = toks.arr[1])
      -- every token must match SOMEWHERE (item_code / translate_name / brand name / brand prefix / piece_count)
      and not exists (
        select 1 from unnest(toks.arr) as t
        where not (c.item_code ilike '%' || t || '%'
                or c.translate_name ilike '%' || t || '%'
                or b.name ilike '%' || t || '%'
                or c.brand_prefix ilike '%' || t || '%'
                or c.piece_count_n::text = t)
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

commit;
