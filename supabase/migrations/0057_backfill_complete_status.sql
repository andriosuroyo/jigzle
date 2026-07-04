-- 0057 — Backfill orders.status = 'Complete' for imported orders that are actually finished.
--
-- Why: the source Sales sheet leaves an order's ORDER-LEVEL status at 'Need send' even after every one
-- of its line items is completed + fulfilled at the LINE level. reconcile_sales.py copies that stale
-- order-level status into orders.status, so ~3.7k genuinely-shipped 2024–2026 orders sit in a
-- non-terminal status and never reach Sales → History (which lists only Complete / Cancelled). The
-- line-level truth (order_lines.shipped_at) is already correct; only the order header is wrong.
--
-- What: a one-time, idempotent correction that sets status = 'Complete' ONLY where the lines already
-- say the order is done — every non-cancelled line is shipped, and at least one non-cancelled line is
-- shipped. No side effects: stock is driven by order_lines.shipped_at (set at import), and there is no
-- trigger on orders.status, so this moves no stock and touches nothing else.
--
-- Safeguards (per the operator's constraints):
--   • order_date <= 2026-07-01 — the last ORDER DATE the Sales CSV covers, so nothing NEWER than the
--     snapshot (app-created orders after it) is touched.
--   • only rows whose status is NOT already Complete/Cancelled change → re-running is a no-op.
--   • requires ALL non-cancelled lines shipped → any order with an open / preorder line (i.e. anything
--     showing in Purchasing → To buy → From Sales) has an unshipped line and is deliberately skipped.
--   • requires >= 1 shipped non-cancelled line → an all-cancelled order is NOT flipped to Complete.
--
-- Preview before applying (counts only, changes nothing):
--   select extract(year from o.order_date) yr, count(*)
--     from public.orders o
--    where o.order_date <= date '2026-07-01'
--      and o.status is distinct from 'Complete' and o.status is distinct from 'Cancelled'
--      and exists (select 1 from public.order_lines l
--                   where l.sales_id = o.sales_id and l.is_cancelled = false and l.shipped_at is not null)
--      and not exists (select 1 from public.order_lines l
--                       where l.sales_id = o.sales_id and l.is_cancelled = false and l.shipped_at is null)
--    group by 1 order by 1 desc;

update public.orders o
   set status = 'Complete'
 where o.order_date <= date '2026-07-01'
   and o.status is distinct from 'Complete'
   and o.status is distinct from 'Cancelled'
   and exists (
     select 1 from public.order_lines l
      where l.sales_id = o.sales_id and l.is_cancelled = false and l.shipped_at is not null
   )
   and not exists (
     select 1 from public.order_lines l
      where l.sales_id = o.sales_id and l.is_cancelled = false and l.shipped_at is null
   );
