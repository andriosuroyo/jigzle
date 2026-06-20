-- Manual apply for migration 0027 (PR23 §2a) — paste into the Supabase SQL editor and Run.
-- Rewrites public.search_skus as a WORD-SPLIT search (every whitespace token, ≥3 chars, must match
-- item_code ILIKE / translate_name ILIKE / exact piece_count_n — so "Snoopy 1000" & "1000 Snoopy"
-- both resolve the 1000-piece SKU) and adds on_the_way to the return. Adding on_the_way changes the
-- return TYPE (3→4 cols), which CREATE OR REPLACE can't do, so we DROP first — wrapped in begin/commit
-- so the swap is ATOMIC (no window where the function is missing and Stock Check's live search errors).
-- Idempotent (drop-if-exists + create + repeatable revoke/grant + create index if not exists).
-- SECURITY INVOKER → same RLS as before. Apply this BEFORE deploying the PR23 app code (Sales now
-- calls this RPC).

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
    from catalogue c, toks
    where toks.n > 0
      and (c.item_code ilike '%' || toks.arr[1] || '%'
        or c.translate_name ilike '%' || toks.arr[1] || '%'
        or c.piece_count_n::text = toks.arr[1])
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
  order by (lower(m.item_code) = lower(btrim(coalesce(p_q, '')))) desc, m.item_code
  limit 20;
$$;

revoke all on function public.search_skus(text) from public, anon;
grant execute on function public.search_skus(text) to authenticated, service_role;

-- Expression index so the piece_count_n::text branch is index-eligible (a plain btree on
-- piece_count_n is NOT used because of the cast). With the 0025 trgm GIN indexes this lets the seed's
-- 3-branch OR BitmapOr instead of seq-scanning ~47k rows. Brief write-lock; idempotent.
-- Verify: explain analyze select * from search_skus('1000 snoopy');  -- expect BitmapOr, not Seq Scan.
create index if not exists catalogue_piece_count_n_text_idx
  on public.catalogue ((piece_count_n::text));

commit;
