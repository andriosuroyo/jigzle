-- Manual apply for migration 0026 (PR20 §2a) — paste into the Supabase SQL editor.
-- Idempotent: create or replace + repeatable revoke/grant. Read-only, additive function; no
-- return-type change to anything existing, so no breakage window for other screens. Apply this
-- BEFORE deploying the PR20 app code (which calls public.search_skus); other screens are unaffected.

create or replace function public.search_skus(p_q text)
returns table(item_code text, name text, available int)
language sql stable security invoker set search_path = public as $$
  with q as (select btrim(coalesce(p_q, '')) as raw),
  cat as (
    select c.item_code,
           coalesce(nullif(c.translate_name, ''), nullif(c.original_name, ''),
                    nullif(c.self_code, ''), c.item_code) as name
    from catalogue c, q
    where q.raw <> '' and (
         c.item_code     ilike '%' || q.raw || '%'
      or c.self_code     ilike '%' || q.raw || '%'
      or c.original_name ilike '%' || q.raw || '%'
      or c.translate_name ilike '%' || q.raw || '%'
    )
    limit 15
  ),
  bc as (
    select distinct b.item_code
    from barcodes b, q
    where q.raw <> '' and b.barcode ilike '%' || q.raw || '%'
    limit 15
  ),
  bc_named as (
    select c.item_code,
           coalesce(nullif(c.translate_name, ''), nullif(c.original_name, ''),
                    nullif(c.self_code, ''), c.item_code) as name
    from catalogue c
    where c.item_code in (select item_code from bc)
      and c.item_code not in (select item_code from cat)
  ),
  merged as (
    select item_code, name, 0 as ord from cat
    union all
    select item_code, name, 1 as ord from bc_named
  )
  select m.item_code, m.name, coalesce(s.available, 0)::int as available
  from merged m
  left join stock_snapshot s on s.item_code = m.item_code
  order by m.ord, m.item_code
  limit 20;
$$;

revoke all on function public.search_skus(text) from public, anon;
grant execute on function public.search_skus(text) to authenticated, service_role;
