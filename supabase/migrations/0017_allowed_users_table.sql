-- Phase 1 — make the allow-list DATA, not code.
--
-- Until now the operator allow-list lived in two hand-edited places: the app's ALLOWED_USER_EMAIL
-- env var (route/UX gate) and a hardcoded array inside is_allowed_user() (the authoritative RLS
-- gate, called by every table's policy). Adding one operator meant editing both and redeploying.
--
-- This migration moves the list into public.allowed_users. is_allowed_user() now reads that table,
-- and both apps' gates (middleware + auth callback) call is_allowed_user() via RPC instead of the
-- env var. Result: the table is the ONE source of truth. Adding/removing an operator is a single
-- row insert/delete in the SQL editor — no migration, no env var, no code deploy.

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------
create table if not exists public.allowed_users (
  email     text primary key,
  note      text,
  added_at  timestamptz not null default now(),
  -- store emails lowercased so the function's lower(jwt.email) = email match is exact
  constraint allowed_users_email_lowercase check (email = lower(email))
);

-- Lock the table: RLS on, and NO policy. With RLS enabled and no policy, no client role (even an
-- allowed, logged-in one) can read or write it directly — the email list stays private. The only
-- thing that can see it is the SECURITY DEFINER function below, which runs as the table owner and
-- bypasses RLS. Manage rows from the Supabase SQL editor (postgres role).
alter table public.allowed_users enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Seed the current ops team (idempotent — safe to re-run)
-- ---------------------------------------------------------------------------
insert into public.allowed_users (email, note) values
  ('andriosuroyo@gmail.com',     'owner'),
  ('jigzle.warehouse@gmail.com', 'warehouse'),
  ('jigzle.drive@gmail.com',     'drive'),
  ('jigzle.adm@gmail.com',       'admin'),
  ('irenechf28@gmail.com',       'irene')
on conflict (email) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Redefine the gate to read the table
-- ---------------------------------------------------------------------------
-- create-or-replace keeps the exact same function every RLS policy already references — no policy
-- or grant changes needed. SECURITY DEFINER so it bypasses RLS on the locked allowed_users table
-- (otherwise the no-policy lock would make it always return false). search_path is pinned to public
-- to prevent search-path hijacking, which is required practice for SECURITY DEFINER functions.
-- The function only ever reveals whether the CALLER'S OWN email is allowed, so it leaks nothing.
create or replace function public.is_allowed_user()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.allowed_users
    where email = lower(auth.jwt() ->> 'email')
  );
$$;

-- Both apps call this via RPC; keep execute available to the session roles (matches prior access).
grant execute on function public.is_allowed_user() to authenticated, anon, service_role;
