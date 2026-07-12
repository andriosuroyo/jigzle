-- 0090 — PR346: give the Catalog "All" search the same natural matching as the Sales SKU search.
-- The Catalog search (searchCatalogue, a PostgREST query-builder) already did all-tokens-AND, word
-- order, brand name/prefix, original_name (#5) and barcode/piece-count — but it could NOT do fuzzy
-- typos (#1) or character/series aliases (#3), because the pg_trgm `<%` operator and the search_aliases
-- expansion can't be expressed through PostgREST filters. This adds a search_catalogue(p_q) RPC that
-- mirrors search_skus's natural logic but returns the Catalog list columns (brand_prefix, needs_review),
-- caps at 200, and keeps Catalog's extra reach: self_code + barcode matching.
--
-- Token model: p_q split on whitespace (tokens ≥2 chars so short brand codes still work; the fuzzy `<%`
-- branch is guarded to ≥3 so it stays meaningful/index-eligible). A row matches iff EVERY token matches
-- SOMEWHERE — item_code / self_code / translate_name / fuzzy translate_name / original_name / brand name
-- / brand prefix / exact piece_count / barcode / OR an alias expansion. AND across tokens, OR across
-- fields (word order irrelevant).
--
-- NULL-safety WITHOUT losing indexes: the per-token gate is `(big OR) IS NOT TRUE` with BARE columns
-- (not coalesce-wrapped) — a token fails when the OR is FALSE *or* NULL, so a NULL column can't leak the
-- row (the bug 0089 fixed), while the bare `col ILIKE`/`t <% col` branches stay eligible for the 0025
-- trgm GIN indexes. `IS NOT TRUE` is the key: `not(NULL)` is NULL (leaks), but `NULL IS NOT TRUE` is TRUE.
--
-- Idempotent: drop-if-exists + create + repeatable revoke/grant. SECURITY INVOKER keeps caller RLS. Ends
-- with a self-check that RAISES (rolls back) if strict-AND isn't enforcing. Verify after applying:
--   select count(*) from search_catalogue('snoopy zzqxnotreal');  -- 0
--   select * from search_catalogue('snopy') limit 5;             -- Snoopy via fuzzy (#1)
--   select * from search_catalogue('peanuts') limit 5;           -- Snoopy items via alias (#3)

begin;

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
      -- seed on the first token (trgm index entry point) — bare columns keep the GINs eligible.
      and (c.item_code ilike '%' || toks.arr[1] || '%'
        or c.self_code ilike '%' || toks.arr[1] || '%'
        or c.translate_name ilike '%' || toks.arr[1] || '%'
        or (length(toks.arr[1]) >= 3 and toks.arr[1] <% c.translate_name)
        or c.original_name ilike '%' || toks.arr[1] || '%'
        or b.name ilike '%' || toks.arr[1] || '%')
      -- every token must match SOMEWHERE. `(OR) IS NOT TRUE` treats FALSE *and* NULL as "no match", so a
      -- NULL column can't defeat the gate — while bare columns stay trgm-index-eligible.
      and not exists (
        select 1 from unnest(toks.arr) as t
        where (
             c.item_code ilike '%' || t || '%'
          or c.self_code ilike '%' || t || '%'
          or c.translate_name ilike '%' || t || '%'
          or (length(t) >= 3 and t <% c.translate_name)                 -- (#1) fuzzy
          or c.original_name ilike '%' || t || '%'                      -- (#5) JP/CN original
          or b.name ilike '%' || t || '%'
          or c.brand_prefix ilike '%' || t || '%'
          or c.piece_count_n::text = t
          or exists (select 1 from barcodes bc                          -- barcode
                     where bc.item_code = c.item_code and bc.barcode ilike '%' || t || '%')
          or exists (select 1 from search_aliases a                     -- (#3) alias expansions
                     where lower(a.term) = lower(t)
                       and (c.item_code ilike '%' || a.alias || '%'
                         or c.translate_name ilike '%' || a.alias || '%'
                         or c.original_name ilike '%' || a.alias || '%'
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

-- self-check: fail loudly (rolls back) if the strict-AND gate isn't enforcing.
do $$
begin
  if (select count(*) from public.search_catalogue('snoopy zzqxnotreal')) <> 0 then
    raise exception 'search_catalogue strict-AND check FAILED: a nonsense token did not filter (got % rows)',
      (select count(*) from public.search_catalogue('snoopy zzqxnotreal'));
  end if;
end $$;

commit;
