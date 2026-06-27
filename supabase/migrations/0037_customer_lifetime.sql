-- 0037 — customer_lifetime: a derived Lifetime-Value view per customer.
--
-- ⚠️ Apply by hand in Supabase (like 0035/0036) when running the Sales backfill. Merging the .sql
-- only version-controls it. Pure additive (a view) — no table/row changes, safe to (re)apply.
--
-- LTV is derived from orders (Sales + Backup, once loaded), NOT stored — so it stays correct as new
-- orders come in. The Customer-Data sheet's LIFETIME SPEND columns are empty, confirming this is the
-- right source. security_invoker → the same RLS (is_allowed_user) that gates the base tables applies.

create or replace view public.customer_lifetime
  with (security_invoker = true)
as
select
  c.customer_id,
  count(distinct o.sales_id) filter (where o.is_cancelled_order is not true)            as orders,
  coalesce(sum(o.sales_total_idr) filter (where o.is_cancelled_order is not true), 0)   as lifetime_spend_idr,
  coalesce(sum(o.paid_idr)        filter (where o.is_cancelled_order is not true), 0)   as lifetime_paid_idr,
  max(o.order_date)                                                                     as last_order_date
from public.customers c
left join (
  -- one row per order, flagged cancelled (orders has no is_cancelled; derive from status)
  select sales_id, customer_id, order_date, sales_total_idr, paid_idr,
         (status = 'Cancelled') as is_cancelled_order
  from public.orders
) o on o.customer_id = c.customer_id
group by c.customer_id;

-- Verify (after applying):
-- select * from public.customer_lifetime order by lifetime_spend_idr desc limit 10;
