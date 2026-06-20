-- Manual apply for migration 0027 (PR23 §2a) — paste into the Supabase SQL editor.
-- Rewrites public.search_skus as a WORD-SPLIT search (every whitespace token, ≥3 chars, must match
-- item_code OR translate_name) and adds on_the_way to the return. Idempotent: create or replace +
-- repeatable revoke/grant. Additive return shape (one extra column; item_code/name/available
-- unchanged), read-only, SECURITY INVOKER → no breakage window for the existing Stock Check caller.
-- Apply this BEFORE deploying the PR23 app code (Sales repoints its searchSkus at this RPC).

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
    from catalogue c, toks
    where toks.n > 0
      and (c.item_code ilike '%' || toks.arr[1] || '%'
        or c.translate_name ilike '%' || toks.arr[1] || '%')
      and not exists (
        select 1 from unnest(toks.arr) as t
        where not (c.item_code ilike '%' || t || '%'
                or c.translate_name ilike '%' || t || '%')
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
