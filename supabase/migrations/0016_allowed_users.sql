-- Phase 1 — multi-operator access. Widen is_allowed_user() from the single owner email to the
-- ops team. is_allowed_user() is the AUTHORITATIVE data gate: every table's RLS policy calls it,
-- so a login the app's middleware lets through is still blocked here unless its email is in this
-- list. Keep this list in sync with the app's ALLOWED_USER_EMAIL env var (middleware + auth
-- callback) — the env var is only the route/UX gate; this function gates every read and write.
--
-- Reads the email from the session JWT (auth.jwt()), lowercased for a case-insensitive match.
-- SECURITY INVOKER (the default for sql functions); create-or-replace keeps the same function the
-- RLS policies already reference, so no policy or grant changes are needed.
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
