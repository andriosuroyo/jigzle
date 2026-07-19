-- 0110 — Brands become a managed Settings list (Settings › Catalog › Brands): add a free-text
-- description alongside the existing name / country / logo_url. Nullable & idempotent; writes are gated
-- by the existing brands_all RLS policy (is_allowed_user).

alter table public.brands add column if not exists description text;
