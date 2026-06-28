-- 0040 — Draft SKUs (PR74). A buy-list "first step": when the Purchasing To-buy add-item search finds
-- no SKU, the operator can stub a new one (code + name) so it can be planned / bought now and enriched
-- in Catalog later. is_draft flags these stubs (a real catalogue row, but not a completed one) so the
-- future Catalog screen can surface "needs completing" and the rest of the app treats it as a normal SKU.
--
-- ⚠️ Apply by hand in Supabase (like 0036 / 0039). Additive + safe: the column is NOT NULL with a
-- default false, so every existing catalogue row stays valid and unchanged.

begin;

alter table public.catalogue
  add column if not exists is_draft boolean not null default false;

commit;

-- ── Verify (run after applying) ───────────────────────────────────────────────
-- select column_name from information_schema.columns
--   where table_name = 'catalogue' and column_name = 'is_draft';
-- -- expect: 1 row
