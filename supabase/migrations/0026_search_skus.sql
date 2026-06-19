-- PR20 §2a — single-round-trip SKU search for the Stock Check Add field. Replaces 2–3 PostgREST
-- calls (catalogue ilike + barcode ilike + barcode-name resolve + stock_snapshot avail) with one
-- function. Same semantics: catalogue text/code ilike (4 cols) + barcode ilike, catalogue hits rank
-- first, cap 20, available from the stock_snapshot matview (0 when absent). SECURITY INVOKER so the
-- same RLS (is_allowed_user) that gates the current direct selects still applies. Uses the 0025
-- pg_trgm GIN indexes (3-char minimum enforced by the caller so the index is eligible).
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
