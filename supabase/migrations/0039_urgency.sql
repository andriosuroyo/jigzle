-- 0039 — Urgency for purchasing + sales (PR73). A buy-priority flag — low / mid / high, rendered
-- green / yellow / red across the Purchasing "To buy" cards and the Sales new-order form.
--
-- ⚠️ Apply by hand in Supabase (like 0034 / 0036). Merging the .sql only version-controls it — it
-- does NOT touch the DB. Additive + safe: both columns are nullable (no default), so every existing
-- row stays valid and the CHECK only constrains the new values.
--
-- Storage:
--   • purchase_orders.urgency — set on a manual (Planned) buy-list item in the add-item overlay.
--   • orders.urgency          — set on the Sales new-order form; surfaced on the From-Sales cards
--                               (the preorder reads its order's urgency). Stamped by submitOrder with a
--                               plain UPDATE after create_order, so the create_order RPC is UNCHANGED.

begin;

alter table public.purchase_orders
  add column if not exists urgency text
  check (urgency in ('low', 'mid', 'high'));

alter table public.orders
  add column if not exists urgency text
  check (urgency in ('low', 'mid', 'high'));

commit;

-- ── Verify (run after applying) ───────────────────────────────────────────────
-- select column_name, table_name from information_schema.columns
--   where column_name = 'urgency' and table_name in ('purchase_orders', 'orders');
-- -- expect: 2 rows
