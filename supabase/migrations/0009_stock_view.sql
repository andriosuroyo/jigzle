-- Phase 1 — The stock engine: the stock_check view.
-- This view IS the "Stock Check" screen. Stock is computed live, never stored.
--
-- Two-stage stock cut: committed at Sales Fulfill (fulfilled_at), physically leaves
-- at Outbound (shipped_at). Per SKU:
--   available  = Σ inbound(not excluded) − Σ fulfilled − Σ holds(active)
--   physical   = Σ inbound(not excluded) − Σ shipped          (warehouse shelf count)
--   reserved   = Σ fulfilled − Σ shipped                       (the picking queue)
--   pending    = Σ purchase_orders where status = 'Processing'
--   on_the_way = Σ purchase_orders where status in ('On the way','With Forwarder')
--   last_receive = max(inbound.receive_date)
-- Identity check: available + reserved + on_hold = physical, by construction.
--
-- security_invoker = true so the querying user's RLS on the base tables applies
-- (the view does not run with the definer's privileges).
-- History reaches back to 2015 on both sides (inbound carries the opening-balance
-- bucket, sales carries the backup archive), so inbound − sales is valid across all
-- time and no separate baseline is needed.
--
-- Built as a plain view; the base-table partial indexes (created in 0005/0006/0007)
-- support the aggregations. Switch to a materialized view + refresh if the screen
-- becomes slow at ~47k SKUs.

create or replace view public.stock_check
  with (security_invoker = true)
as
with inb as (
  select item_code,
         sum(qty) filter (where not excluded) as inbound_qty,
         max(receive_date)                    as last_receive
  from public.inbound
  where item_code is not null
  group by item_code
),
sales as (
  select item_code,
         sum(qty) filter (where fulfilled_at is not null and not is_cancelled) as fulfilled_qty,
         sum(qty) filter (where shipped_at   is not null and not is_cancelled) as shipped_qty
  from public.order_lines
  where item_code is not null
  group by item_code
),
hld as (
  select item_code,
         sum(qty) as hold_qty
  from public.holds
  where released_at is null
  group by item_code
),
po as (
  select item_code,
         sum(qty) filter (where status = 'Processing')                    as pending_qty,
         sum(qty) filter (where status in ('On the way', 'With Forwarder')) as on_the_way_qty
  from public.purchase_orders
  where item_code is not null
  group by item_code
)
select
  c.item_code,
  coalesce(inb.inbound_qty, 0)   - coalesce(sales.fulfilled_qty, 0) - coalesce(hld.hold_qty, 0) as available,
  coalesce(inb.inbound_qty, 0)   - coalesce(sales.shipped_qty, 0)                               as physical,
  coalesce(sales.fulfilled_qty, 0) - coalesce(sales.shipped_qty, 0)                             as reserved,
  coalesce(hld.hold_qty, 0)      as on_hold,
  coalesce(po.pending_qty, 0)    as pending,
  coalesce(po.on_the_way_qty, 0) as on_the_way,
  inb.last_receive
from public.catalogue c
left join inb   on inb.item_code   = c.item_code
left join sales on sales.item_code = c.item_code
left join hld   on hld.item_code   = c.item_code
left join po    on po.item_code    = c.item_code;
