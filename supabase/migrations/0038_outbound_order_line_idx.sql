-- 0038 — index outbound_shipments.order_line_id.
--
-- ⚠️ Apply by hand in Supabase. Pure additive (an index) — instant on ~12k rows, safe to (re)run.
--
-- outbound_shipments.sales_id is indexed (0014) but order_line_id is NOT. Reloading the sales cluster
-- (delete orders → cascade order_lines) re-checks the order_line_id FK per deleted line; without an
-- index that's a sequential scan of outbound_shipments per row → statement timeout. This indexes it.

create index if not exists outbound_shipments_order_line_id_idx
  on public.outbound_shipments (order_line_id);
