-- apply-0017.sql
-- Paste-ready for the Supabase SQL editor (ref tocmwitawwtxmnwrbyab). Run it once.
-- SQL is identical to supabase/migrations/0017_allowed_users_table.sql; only this banner is added.
--
-- What it does: moves the operator allow-list out of code and into the public.allowed_users table,
-- and repoints is_allowed_user() (the authoritative RLS gate) to read that table. After this runs,
-- the table is the ONE place you manage access.
--
-- Safe ordering note: the app code that calls is_allowed_user() via RPC works whether or not this
-- has run yet (the old 0016 function returns the same 5 results), so you can run this before or
-- after the Vercel redeploy. Once it's in, ALLOWED_USER_EMAIL is no longer read anywhere.
--
-- To add an operator later (no migration, no deploy):
--   insert into public.allowed_users (email, note) values ('newperson@gmail.com', 'role') ;
-- To remove one:
--   delete from public.allowed_users where email = 'someone@gmail.com' ;

-- ============================================================================
-- 0017_allowed_users_table.sql
-- ============================================================================
create table if not exists public.allowed_users (
  email     text primary key,
  note      text,
  added_at  timestamptz not null default now(),
  constraint allowed_users_email_lowercase check (email = lower(email))
);

alter table public.allowed_users enable row level security;

insert into public.allowed_users (email, note) values
  ('andriosuroyo@gmail.com',     'owner'),
  ('jigzle.warehouse@gmail.com', 'warehouse'),
  ('jigzle.drive@gmail.com',     'drive'),
  ('jigzle.adm@gmail.com',       'admin'),
  ('irenechf28@gmail.com',       'irene')
on conflict (email) do nothing;

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

grant execute on function public.is_allowed_user() to authenticated, anon, service_role;

-- Confirm the 5 rows are in:
-- select email, note, added_at from public.allowed_users order by added_at;
