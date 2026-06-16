-- apply-0016.sql
-- Paste-ready for the Supabase SQL editor. Widens is_allowed_user() to the ops team so the new
-- Google logins can actually read/write (RLS). SQL is identical to
-- supabase/migrations/0016_allowed_users.sql; only this banner is added. Run it once
-- (ref tocmwitawwtxmnwrbyab). Keep the email list in sync with the app's ALLOWED_USER_EMAIL.
--
-- IMPORTANT: until this runs, the new emails can sign in (app gate) but every query is blocked
-- by RLS (this function still allows only andriosuroyo@gmail.com).

-- ============================================================================
-- 0016_allowed_users.sql
-- ============================================================================
create or replace function public.is_allowed_user()
returns boolean
language sql
stable
as $$
  select coalesce(
    lower(auth.jwt() ->> 'email') = any (array[
      'andriosuroyo@gmail.com',
      'jigzle.warehouse@gmail.com',
      'jigzle.drive@gmail.com',
      'jigzle.adm@gmail.com',
      'irenechf28@gmail.com'
    ]),
    false
  );
$$;
