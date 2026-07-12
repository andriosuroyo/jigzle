-- 0089 — PR345: reinstall public.search_skus(p_q) with the strict all-tokens-AND actually enforcing.
-- After 0087/0088, production had fuzzy (#1) + aliases (#3) + original-name (#5) working, but the
-- "every token must match somewhere" gate was silently NOT filtering: `search_skus('snoopy 5000')`
-- returned Snoopy items with no 5000 anywhere, and `snoopy zzqxnotreal` returned 20 instead of 0.
--
-- ROOT CAUSE — NULL three-valued logic. The per-token predicate is `not (branch1 or branch2 or …)`.
-- Several branches compare against NULLable columns: b.name (NULL when the LEFT JOIN finds no brand),
-- c.piece_count_n::text (NULL when piece count is unset), c.original_name, c.translate_name. When a
-- garbage token matches none of them and at least one such column is NULL, the OR chain is
-- `false or … or NULL` = NULL (not FALSE). Then `not(NULL)` = NULL, so `where not(...)` does NOT select
-- that token, the NOT EXISTS stays TRUE, and the row is wrongly KEPT. (0027 had the same latent hole via
-- NULL translate_name/piece_count; the extra NULLable columns here made it fire on almost every row.)
--
-- FIX — make every NULLable branch NULL-safe with coalesce(col,'') so each token's match is strictly
-- TRUE/FALSE. item_code is the PK (never NULL) so it needs no wrap. Now a nonsense token evaluates FALSE
-- everywhere → not(FALSE)=TRUE → EXISTS → row excluded. AND is restored; fuzzy/alias/original unchanged.
--
-- Idempotent: drop-if-exists + create + repeatable revoke/grant. SECURITY INVOKER keeps caller RLS. Ends
-- with a self-check that RAISES (rolling back) if strict-AND still isn't enforcing, so a bad state can't
-- silently look "applied". Verify after applying:
--   select count(*) from search_skus('snoopy zzqxnotreal');  -- 0
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
      -- seed on the first token (index entry point) — mirrors the per-token branches, NULL-safe.
      and (c.item_code ilike '%' || toks.arr[1] || '%'
        or coalesce(c.translate_name, '') ilike '%' || toks.arr[1] || '%'
        or toks.arr[1] <% coalesce(c.translate_name, '')
        or coalesce(c.original_name, '') ilike '%' || toks.arr[1] || '%'
        or coalesce(b.name, '') ilike '%' || toks.arr[1] || '%')
      -- EVERY token must match SOMEWHERE. Every NULLable branch is coalesced so the OR chain is strictly
      -- TRUE/FALSE (never NULL) — otherwise a NULL would defeat the `not(...)` and leak the row.
      and not exists (
        select 1 from unnest(toks.arr) as t
        where not (
             c.item_code ilike '%' || t || '%'
          or coalesce(c.translate_name, '') ilike '%' || t || '%'
          or t <% coalesce(c.translate_name, '')                        -- (#1) fuzzy
          or coalesce(c.original_name, '') ilike '%' || t || '%'        -- (#5) JP/CN original
          or coalesce(b.name, '') ilike '%' || t || '%'
          or coalesce(c.brand_prefix, '') ilike '%' || t || '%'
          or coalesce(c.piece_count_n::text, '') = t
          or exists (                                                   -- (#3) alias expansions
               select 1 from search_aliases a
               where lower(a.term) = lower(t)
                 and (c.item_code ilike '%' || a.alias || '%'
                   or coalesce(c.translate_name, '') ilike '%' || a.alias || '%'
                   or coalesce(c.original_name, '') ilike '%' || a.alias || '%'
                   or coalesce(b.name, '') ilike '%' || a.alias || '%')
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

-- self-check: fail loudly (rolls back) if the strict-AND gate still isn't enforcing.
do $$
begin
  if (select count(*) from public.search_skus('snoopy zzqxnotreal')) <> 0 then
    raise exception 'search_skus strict-AND check FAILED: a nonsense token did not filter (got % rows)',
      (select count(*) from public.search_skus('snoopy zzqxnotreal'));
  end if;
end $$;

commit;
