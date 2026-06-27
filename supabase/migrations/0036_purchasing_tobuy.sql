-- 0036 — Purchasing "To buy" stage: Planned + Sold out PO states, a product link, and the sold-out
-- date/reason. Foundation for the To-buy tab (Planned add-item flow + Sold-out marking).
--
-- ⚠️ Apply by hand in Supabase (like 0034). Merging the .sql only version-controls it — it does NOT
-- touch the DB. Additive + safe: new columns are nullable; the status CHECK is only WIDENED (never
-- narrowed), so every existing row stays valid.
--
-- Per the agreed model:
--   • Planned  = a manual buy-list item, not yet bought (status 'Planned' + product_link).
--   • Sold out = can't be purchased right now (status 'Sold out' + sold_out_date auto-stamped on mark,
--                + optional sold_out_note reason).
--   • Preorder = derived from Sales (no schema). Confirm-get = the existing 'With Forwarder' (no schema).
--
-- stock_check (0009) is UNCHANGED on purpose: its `po` CTE only sums 'Processing' (pending) and
-- 'On the way'/'With Forwarder' (on_the_way). 'Planned' and 'Sold out' match neither, so they
-- correctly contribute 0 incoming stock — a planned item isn't bought yet, a sold-out one can't be.

begin;

-- 1) Widen purchase_orders.status to allow the two new states. Drop the existing status CHECK by
--    whatever name it carries (0007 created it inline → 'purchase_orders_status_check'), then re-add
--    the widened set under a stable name.
do $$
declare cname text;
begin
  select conname into cname
  from pg_constraint
  where conrelid = 'public.purchase_orders'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%status%';
  if cname is not null then
    execute format('alter table public.purchase_orders drop constraint %I', cname);
  end if;
end $$;

alter table public.purchase_orders
  add constraint purchase_orders_status_check
  check (status in ('Planned', 'Processing', 'On the way', 'With Forwarder', 'Received', 'Sold out'));

-- 2) New columns (all nullable; existing rows unaffected).
alter table public.purchase_orders
  add column if not exists product_link  text,   -- supplier / marketplace URL for a planned buy
  add column if not exists sold_out_date date,    -- date first seen sold out (stamped when marked)
  add column if not exists sold_out_note text;    -- optional reason ("discontinued", "OOS until …")

commit;

-- ── Verify (run after applying) ───────────────────────────────────────────────
-- select pg_get_constraintdef(oid) from pg_constraint
--   where conrelid = 'public.purchase_orders'::regclass and conname = 'purchase_orders_status_check';
-- -- expect: CHECK (status IN ('Planned','Processing','On the way','With Forwarder','Received','Sold out'))
-- select column_name from information_schema.columns
--   where table_name = 'purchase_orders' and column_name in ('product_link','sold_out_date','sold_out_note');
-- -- expect: 3 rows
