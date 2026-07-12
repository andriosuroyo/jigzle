-- 0087 — PR343: make public.search_skus(p_q) a "natural" SKU search you don't have to memorise codes for.
-- Supersedes the drifted live function and folds in three upgrades on top of the 0027 token model:
--
--   (#5) ORIGINAL name — also match the Japanese/Chinese original_name (スヌーピー, 史努比幻想物語), so a
--        token found only in the source-language title still resolves. Index-backed by 0025's trgm GIN.
--   (#1) FUZZY / typo tolerance — pg_trgm word_similarity (`<%`) against translate_name, so "snopy" still
--        finds Snoopy. Uses the SAME gin_trgm_ops index (0025): in `tk <% translate_name` the indexed
--        column is on the right, which is the form the GIN index accelerates. Default word_similarity
--        threshold (0.6) is tolerant of 1–2 char typos without over-matching.
--   (#3) ALIASES / character & series names — a small `search_aliases(term, alias)` table lets a token
--        expand to extra literals ("peanuts" → also try "snoopy"), so you can search by the franchise or
--        character even when the SKU name uses the brand. Editable by the operator (seed + template below).
--
-- Token model (from 0027, kept): p_q is split on whitespace into tokens (each ≥3 chars so the trgm GIN
-- stays eligible); a SKU matches iff EVERY token matches SOMEWHERE. Per token, "somewhere" now means any of:
--   item_code ILIKE · translate_name ILIKE · translate_name word-similar (`<%`, fuzzy) · original_name ILIKE
--   · brand name ILIKE · brand prefix ILIKE · exact piece_count · OR any of the token's ALIAS expansions
--   (ILIKE on item_code / translate_name / original_name / brand name).
-- AND across tokens, OR across fields — so word order is irrelevant ("clover snoopy 1000" == "snoopy
-- clover 1000") and each concept can be satisfied by a different column.
--
-- Idempotent: table/policy/index/seeds are IF-NOT-EXISTS or ON-CONFLICT; the function is drop+create with
-- a repeatable revoke/grant. SECURITY INVOKER keeps the caller's RLS on catalogue/stock_snapshot.
-- Verify after applying:
--   select count(*) from search_skus('snoopy zzqxnotreal');   -- 0 (strict AND restored)
--   select * from search_skus('snopy') limit 5;               -- Snoopy items via fuzzy (#1)
--   select * from search_skus('peanuts 1000') limit 5;        -- Snoopy 1000pc via alias (#3)
--   select * from search_skus('clover snoopy 1000') limit 5;  -- word order + brand name
--   -- perf: run `explain analyze select * from search_skus('snoopy')` to confirm a bitmap index scan.

begin;

-- (#3) operator-editable alias table. term/alias are matched case-insensitively; store lowercase.
create table if not exists public.search_aliases (
  term  text not null,
  alias text not null,
  primary key (term, alias)
);
alter table public.search_aliases enable row level security;

-- gate reads to signed-in allowed users, same as the rest of the app; writes are operator-only (SQL editor).
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'search_aliases' and policyname = 'search_aliases_select'
  ) then
    create policy search_aliases_select on public.search_aliases
      for select using (public.is_allowed_user());
  end if;
end $$;

-- lookup index for the per-token expansion.
create index if not exists search_aliases_term_lower_idx on public.search_aliases (lower(term));

-- seed example: the Peanuts franchise ⇄ its Snoopy brand name. Bidirectional so either word finds the other.
insert into public.search_aliases (term, alias) values
  ('peanuts', 'snoopy'),
  ('snoopy',  'peanuts')
on conflict do nothing;
-- To add your own, run e.g.:  insert into public.search_aliases(term,alias) values ('lowercase-search-word','lowercase-alias') on conflict do nothing;

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
      -- seed on the first token (index entry point). Mirrors the per-token predicate's *literal* branches
      -- + fuzzy; alias/piece_count are cheap and checked in the AND pass, so leaving them off the seed
      -- keeps this an index-eligible scan (note: `tk <% col` — indexed column on the right).
      and (c.item_code ilike '%' || toks.arr[1] || '%'
        or c.translate_name ilike '%' || toks.arr[1] || '%'
        or toks.arr[1] <% c.translate_name
        or c.original_name ilike '%' || toks.arr[1] || '%'
        or b.name ilike '%' || toks.arr[1] || '%')
      -- every token must match SOMEWHERE, across all fields incl. alias expansions.
      and not exists (
        select 1 from unnest(toks.arr) as tk
        where not (
             c.item_code ilike '%' || tk || '%'
          or c.translate_name ilike '%' || tk || '%'
          or tk <% c.translate_name                              -- (#1) fuzzy (indexed column on right)
          or c.original_name ilike '%' || tk || '%'              -- (#5) JP/CN original
          or b.name ilike '%' || tk || '%'
          or c.brand_prefix ilike '%' || tk || '%'
          or c.piece_count_n::text = tk
          or exists (                                            -- (#3) alias expansions
               select 1 from search_aliases a
               where lower(a.term) = lower(tk)
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

commit;
