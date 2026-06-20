-- PR23 §2a — rewrite public.search_skus(p_q) as a WORD-SPLIT search shared by Sales and Stock Check.
-- Fixes "Snoopy 1000" returning nothing: the old (0026) body matched the WHOLE typed string as one
-- substring, so a name token ("Snoopy") and a code/piece token ("1000") that live in different fields
-- never co-occurred in one column → zero hits. Now p_q is split on whitespace into tokens (each ≥3
-- chars so the 0025 pg_trgm GIN index stays eligible) and a SKU matches iff EVERY token matches
-- SOMEWHERE — item_code OR translate_name (AND across tokens, OR across the two fields).
--
-- D2: matching drops self_code (brand-prefix noise that flooded results), original_name and barcode;
-- the DISPLAY name still falls back through them (coalesce) so an untranslated SKU still shows a name.
-- D3: adds on_the_way to the return (PR24's readiness label). D4: available/on_the_way come from the
-- stock_snapshot matview via LEFT JOIN, so a 0-stock preorder SKU still appears (avail 0, on_the_way
-- reflecting any incoming PO). Exact item_code match ranks first, then item_code; cap 20.
--
-- Idempotent (create or replace + repeatable revoke/grant); additive return shape (one extra column,
-- the existing item_code/name/available unchanged) → no breakage for the other RPC caller. Apply this
-- BEFORE deploying the PR23 app code (Sales now calls this RPC). SECURITY INVOKER → the same RLS
-- (is_allowed_user) that gated the prior direct selects still applies.

create or replace function public.search_skus(p_q text)
returns table(item_code text, name text, available int, on_the_way int)
language sql stable security invoker set search_path = public as $$
  with toks as (
    -- whitespace tokens, original order kept; drop empties and <3-char tokens (pg_trgm needs ≥3 chars
    -- per trigram). All-too-short / blank input → zero usable tokens → n = 0, arr = NULL.
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
      -- Seed on the first token so the trgm GIN index drives the scan (a direct, indexable predicate
      -- on c). Logically redundant — the NOT EXISTS below already requires arr[1] to match — so it
      -- never changes the result set; it only gives the planner an index entry point.
      and (c.item_code ilike '%' || toks.arr[1] || '%'
        or c.translate_name ilike '%' || toks.arr[1] || '%')
      -- Require EVERY token to match somewhere (item_code OR translate_name): the row is kept iff no
      -- token fails.
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
  -- exact whole-query item_code match first, then item_code A–Z; order-then-limit so the exact hit is
  -- never dropped by the cap.
  order by (lower(m.item_code) = lower(btrim(coalesce(p_q, '')))) desc, m.item_code
  limit 20;
$$;

revoke all on function public.search_skus(text) from public, anon;
grant execute on function public.search_skus(text) to authenticated, service_role;
