-- PR408 — Outbound → History search as one RPC, so the name search is specific.
--
-- Replaces the PostgREST `.or(…ilike…)` filter in getOutboundHistory (apps/ops/app/outbound/actions.ts),
-- which had to strip brackets/commas from the search text (they are PostgREST filter grammar) — so the full
-- customer label "Tessa S (1895)" matched nothing. Here the text is a plain parameter (data, never spliced
-- into a filter string) and matched as a literal, case-insensitive substring (strpos on lower()).
--
-- What it adds over the old filter:
--   • matches the LINKED customer's name (customers.name via customer_id) and its full ID label
--     ("<name> (<last4>)", same rule as customerIdLabel in @jigzle/lib) — app shipments carry no
--     customer_ref, so before this they were only found by recipient name.
--   • ranks each SHIPMENT by its best-matching item row, then newest first inside each group:
--       1 customer name equals the text (case-insensitive, outer spaces ignored; the name also counts
--         without its trailing "(last4)" ID code, so "Tessa S" equals "Tessa S (1895)")
--       2 customer name contains it
--       3 recipient name contains it
--       4 SKU (item_code / item_code_raw), note or courier contains it
--     "Customer name" = customers.name, its ID label, customer_ref, and — only for an unlinked row with no
--     customer_ref — recipient_name (that row's headline in the UI).
--   • applies the shipment cap (p_limit) AFTER that order, so group 1–2 hits are never pushed out by newer
--     group-4 hits.
--   • returns EVERY item row of each matched shipment (not only the rows that matched), so the History
--     detail shows the whole shipment.
--
-- Shipment grouping mirrors the app: by send_id for app ships, else the repeated shipment-level fields
-- (customer_ref | ship_date | address | courier | weight_gram), with null and '' treated alike as the app's
-- `?? ''` key does. Numeric grouping/joins compare by value (1500 = 1500.0), as JS numbers do.
--
-- SECURITY INVOKER: RLS (is_allowed_user) on outbound_shipments + customers still gates every row.
-- Idempotent (create or replace). Read-only. ~50 ms on 13k rows (one seq scan; a cheap one-string
-- pre-filter runs before the per-field ranking).

create or replace function public.search_outbound_history(p_q text, p_limit int default 100)
returns table(
  customer_ref text,
  recipient_name text,
  ship_date date,
  address text,
  courier text,
  weight_gram numeric,
  qty int,
  item_code text,
  item_code_raw text,
  note text,
  verify_method text,
  scanned_barcode text,
  sales_id text,
  customer_id bigint,
  send_id text,
  dispatched_at timestamptz,
  staff text,
  match_group int,
  match_rank int
)
language sql stable security invoker set search_path = public as $$
  with pat as (
    select lower(btrim(coalesce(p_q, ''))) as norm
  ),
  -- customers whose name / ID label contains the text: group 1 (equal) or 2 (contains)
  cust_hit as (
    select k.customer_id,
           case when p.norm = k.n or p.norm = k.l
                  or p.norm = btrim(regexp_replace(k.n, '\s*\(\d{2,}\)$', ''))
                then 1 else 2 end as g
    from (
      select c.customer_id,
             lower(btrim(c.name)) as n,
             lower(case
               when coalesce(nullif(btrim(c.name), ''), '(no name)') ~ '\(\d{2,}\)$'
                 then coalesce(nullif(btrim(c.name), ''), '(no name)')
               when length(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g')) >= 4
                 then coalesce(nullif(btrim(c.name), ''), '(no name)')
                      || ' (' || right(regexp_replace(c.phone, '\D', '', 'g'), 4) || ')'
               else coalesce(nullif(btrim(c.name), ''), '(no name)')
             end) as l
      from customers c
    ) k, pat p
    where p.norm <> '' and strpos(k.l, p.norm) > 0
  ),
  -- candidate item rows: a linked-customer hit, or the text appears in any searched field
  cand as materialized (
    select o.send_id, o.customer_ref, o.recipient_name, o.ship_date, o.address, o.courier, o.weight_gram,
           o.item_code, o.item_code_raw, o.note, o.customer_id, ch.g as cust_g
    from outbound_shipments o
    cross join pat p
    left join cust_hit ch on ch.customer_id = o.customer_id
    where o.ship_date is not null
      and p.norm <> ''
      and (ch.g is not null
           or strpos(lower(concat_ws(chr(31), o.customer_ref, o.recipient_name, o.item_code,
                                     o.item_code_raw, o.note, o.courier)), p.norm) > 0)
  ),
  scored as (
    select o.send_id, o.customer_ref, o.ship_date, o.address, o.courier, o.weight_gram,
           least(o.cust_g,
             case
               when p.norm = lower(btrim(o.customer_ref))
                 or p.norm = btrim(regexp_replace(lower(btrim(o.customer_ref)), '\s*\(\d{2,}\)$', ''))
                 or (o.customer_id is null and coalesce(btrim(o.customer_ref), '') = ''
                     and p.norm = lower(btrim(o.recipient_name)))
                 then 1
               when strpos(lower(o.customer_ref), p.norm) > 0
                 or (o.customer_id is null and coalesce(btrim(o.customer_ref), '') = ''
                     and strpos(lower(o.recipient_name), p.norm) > 0)
                 then 2
               when strpos(lower(o.recipient_name), p.norm) > 0
                 then 3
               when strpos(lower(o.item_code), p.norm) > 0
                 or strpos(lower(o.item_code_raw), p.norm) > 0
                 or strpos(lower(o.note), p.norm) > 0
                 or strpos(lower(o.courier), p.norm) > 0
                 then 4
             end) as grp
    from cand o cross join pat p
  ),
  -- one row per shipment: its best group + date
  hits as (
    select s.send_id as k_send,
           case when s.send_id is null then coalesce(s.customer_ref, '') end as k_ref,
           case when s.send_id is null then s.ship_date end as k_date,
           case when s.send_id is null then coalesce(s.address, '') end as k_addr,
           case when s.send_id is null then coalesce(s.courier, '') end as k_courier,
           case when s.send_id is null then coalesce(s.weight_gram, -1) end as k_w,
           min(s.grp) as grp,
           max(s.ship_date) as d
    from scored s
    where s.grp is not null
    group by 1, 2, 3, 4, 5, 6
  ),
  -- rank, THEN cap
  picked as materialized (
    select r.* from (
      select h.*,
             (row_number() over (order by h.grp, h.d desc, h.k_send, h.k_ref, h.k_addr, h.k_courier, h.k_w))::int as rnk
      from hits h
    ) r
    where r.rnk <= greatest(coalesce(p_limit, 100), 1)
  ),
  -- every item row of the picked shipments
  items as (
    select o.shipment_id, o.customer_ref, o.recipient_name, o.ship_date, o.address, o.courier, o.weight_gram,
           o.qty, o.item_code, o.item_code_raw, o.note, o.verify_method, o.scanned_barcode, o.sales_id,
           o.customer_id, o.send_id, o.dispatched_at, o.staff, t.grp, t.rnk
    from outbound_shipments o
    join picked t on t.k_send is not null and o.send_id = t.k_send
    where o.ship_date is not null
    union all
    select o.shipment_id, o.customer_ref, o.recipient_name, o.ship_date, o.address, o.courier, o.weight_gram,
           o.qty, o.item_code, o.item_code_raw, o.note, o.verify_method, o.scanned_barcode, o.sales_id,
           o.customer_id, o.send_id, o.dispatched_at, o.staff, t.grp, t.rnk
    from outbound_shipments o
    join picked t
      on t.k_send is null and o.send_id is null
     and o.ship_date = t.k_date
     and coalesce(o.customer_ref, '') = t.k_ref
     and coalesce(o.address, '') = t.k_addr
     and coalesce(o.courier, '') = t.k_courier
     and coalesce(o.weight_gram, -1) = t.k_w
  )
  select i.customer_ref, i.recipient_name, i.ship_date, i.address, i.courier, i.weight_gram, i.qty,
         i.item_code, i.item_code_raw, i.note, i.verify_method, i.scanned_barcode, i.sales_id,
         i.customer_id, i.send_id, i.dispatched_at, i.staff, i.grp, i.rnk
  from items i
  order by i.rnk, i.shipment_id;
$$;

grant execute on function public.search_outbound_history(text, int) to authenticated, service_role;
