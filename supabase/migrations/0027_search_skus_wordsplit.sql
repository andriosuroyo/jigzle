-- PR23 §2a — rewrite public.search_skus(p_q) as a WORD-SPLIT search shared by Sales and Stock Check.
-- Fixes "Snoopy 1000" returning nothing: the old (0026) body matched the WHOLE typed string as one
-- substring, so a name token ("Snoopy") and a code/piece token ("1000") that live in different fields
-- never co-occurred in one column → zero hits. Now p_q is split on whitespace into tokens (each ≥3
-- chars so the 0025 pg_trgm GIN index stays eligible) and a SKU matches iff EVERY token matches
-- SOMEWHERE — item_code ILIKE, translate_name ILIKE, OR an exact piece_count_n match (AND across
-- tokens, OR across the three fields). The piece_count_n branch is the real "Snoopy 1000" fix: the
-- piece count lives in its own column, so a token like "1000" must match it directly (exact = low
-- noise) — "Snoopy 1000" and "1000 Snoopy" both resolve.
--
-- D2: matching drops self_code (brand-prefix noise that flooded results), original_name and barcode;
-- the DISPLAY name still falls back through them (coalesce) so an untranslated SKU still shows a name.
-- D3: adds on_the_way to the return (PR24's readiness label). D4: available/on_the_way come from the
-- stock_snapshot matview via LEFT JOIN, so a 0-stock preorder SKU still appears (avail 0, on_the_way
-- reflecting any incoming PO). Exact item_code match ranks first, then item_code; cap 20.
--
-- Also creates an EXPRESSION index on (piece_count_n::text) so the new piece-count branch is
-- index-eligible: the ::text cast means a plain btree on piece_count_n would NOT be used, so the
-- expression itself is indexed. With it + the 0025 trgm GIN indexes (item_code/translate_name), the
-- seed's 3-branch OR can plan as a BitmapOr (bitmap index scans) instead of a seq scan over ~47k
-- catalogue rows on every search.
--
-- Adding on_the_way changes the return TYPE (3 cols → 4), which CREATE OR REPLACE FUNCTION cannot do
-- — Postgres requires DROP FUNCTION first ("cannot change return type of existing function"). So this
-- drops the old function then recreates it, all inside one begin/commit so the swap is ATOMIC: there
-- is no window where the function is missing and Stock Check's live search (the existing RPC caller)
-- would error. The extra column is still additive TO THAT CALLER (it ignores on_the_way). Idempotent
-- / re-runnable (drop-if-exists + create + repeatable revoke/grant + create index if not exists).
-- Apply this BEFORE deploying the PR23 app code (Sales now calls this RPC). SECURITY INVOKER → the
-- same RLS (is_allowed_user) that gated the prior direct selects still applies.

begin;

-- DROP first: a new return column is a return-type change that CREATE OR REPLACE rejects. if-exists
-- keeps re-runs clean; the begin/commit wrap makes the drop+recreate one atomic swap.
drop function if exists public.search_skus(text);

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
      -- Seed on the first token (an index entry point for the trgm GIN scan). It MIRRORS the NOT
      -- EXISTS predicate below EXACTLY — including the piece_count_n branch — so it never wrongly
      -- excludes a row: a number-first query like "1000 Snoopy" (where 1000 lives only in
      -- piece_count_n) still passes the seed because the seed checks piece_count_n too.
      and (c.item_code ilike '%' || toks.arr[1] || '%'
        or c.translate_name ilike '%' || toks.arr[1] || '%'
        or c.piece_count_n::text = toks.arr[1])
      -- Require EVERY token to match somewhere (item_code ILIKE / translate_name ILIKE / exact
      -- piece_count_n): the row is kept iff no token fails.
      and not exists (
        select 1 from unnest(toks.arr) as t
        where not (c.item_code ilike '%' || t || '%'
                or c.translate_name ilike '%' || t || '%'
                or c.piece_count_n::text = t)
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

-- Expression index for the piece_count_n branch of the per-token predicate (a plain btree on
-- piece_count_n is NOT used because of the ::text cast — index the expression). Lets the seed's
-- 3-branch OR BitmapOr with the 0025 trgm GIN indexes rather than seq-scanning ~47k rows per search.
-- Non-concurrent (brief write-lock on catalogue; idempotent via if-not-exists). Verify post-apply:
--   explain analyze select * from search_skus('1000 snoopy');  -- expect BitmapOr, not Seq Scan.
create index if not exists catalogue_piece_count_n_text_idx
  on public.catalogue ((piece_count_n::text));

commit;
