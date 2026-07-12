-- 0089 — PR345: reinstall public.search_skus(p_q) with the strict all-tokens-AND intact.
-- After 0087/0088, production had fuzzy (#1) + aliases (#3) + original-name (#5) working, but the
-- "every token must match somewhere" gate (the NOT EXISTS clause) was not enforcing — e.g.
-- `search_skus('snoopy 5000')` returned Snoopy items with no 5000 anywhere, and `snoopy zzqxnotreal`
-- returned 20 instead of 0. This file replaces the function body with the correct one (structurally the
-- proven 0027 gate, plus the fuzzy/original/brand/alias branches). Table/policies/seed already exist
-- (0087/0088); this touches ONLY the function, so it's the minimal, unmistakable fix to run.
--
-- Idempotent: drop-if-exists + create + repeatable revoke/grant. SECURITY INVOKER keeps caller RLS.
-- Verify after applying (all must hold):
--   select count(*) from search_skus('snoopy zzqxnotreal');  -- 0  (strict AND)
--   select count(*) from search_skus('snoopy 5000');         -- only genuine 5000-piece Snoopy (few/none)
--   select * from search_skus('snopy') limit 5;              -- Snoopy via fuzzy (#1)
--   select * from search_skus('peanuts 1000') limit 5;       -- Snoopy 1000pc via alias (#3)

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
      -- seed on the first token (index entry point) — mirrors the literal + fuzzy branches below.
      and (c.item_code ilike '%' || toks.arr[1] || '%'
        or c.translate_name ilike '%' || toks.arr[1] || '%'
        or toks.arr[1] <% c.translate_name
        or c.original_name ilike '%' || toks.arr[1] || '%'
        or b.name ilike '%' || toks.arr[1] || '%')
      -- EVERY token must match SOMEWHERE — the row is kept iff no token fails all branches.
      and not exists (
        select 1 from unnest(toks.arr) as t
        where not (
             c.item_code ilike '%' || t || '%'
          or c.translate_name ilike '%' || t || '%'
          or t <% c.translate_name                                -- (#1) fuzzy (indexed column on right)
          or c.original_name ilike '%' || t || '%'                -- (#5) JP/CN original
          or b.name ilike '%' || t || '%'
          or c.brand_prefix ilike '%' || t || '%'
          or c.piece_count_n::text = t
          or exists (                                             -- (#3) alias expansions
               select 1 from search_aliases a
               where lower(a.term) = lower(t)
                 and (c.item_code ilike '%' || a.alias || '%'
                   or c.translate_name ilike '%' || a.alias || '%'
                   or c.original_name ilike '%' || a.alias || '%'
                   or b.name ilike '%' || a.alias || '%')
             )
        )
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

-- self-check: fail loudly (rolls back) if the strict-AND gate still isn't enforcing, so a bad paste
-- can't silently look "applied". A nonsense second token must drop the row count to zero.
do $$
begin
  if (select count(*) from public.search_skus('snoopy zzqxnotreal')) <> 0 then
    raise exception 'search_skus strict-AND check FAILED: a nonsense token did not filter (got % rows)',
      (select count(*) from public.search_skus('snoopy zzqxnotreal'));
  end if;
end $$;

commit;
