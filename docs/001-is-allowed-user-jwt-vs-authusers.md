# 001 — `is_allowed_user()` reads from JWT, not `auth.users`

**Date:** 2026-05-14
**Status:** Accepted

## Context

`0001_init.sql` (the initial schema migration) created a function `is_allowed_user()` that gates Row-Level Security on every reference table. The original definition queried `auth.users` directly:

```sql
CREATE FUNCTION is_allowed_user() RETURNS boolean AS $$
  SELECT coalesce(
    (SELECT email FROM auth.users WHERE id = auth.uid()) = 'andriosuroyo@gmail.com',
    false
  );
$$ LANGUAGE sql STABLE;
```

When deployed, every read against `shipping_methods`, `currencies`, etc. returned zero rows for the authenticated user, even though the data was seeded correctly. The signed-in user could authenticate (they showed up in `auth.users` with the right email) but RLS filtered everything to empty.

Root cause: Supabase's `authenticated` role does not have `SELECT` privilege on the `auth.users` table. The subquery returned NULL, the comparison `NULL = '...'` is NULL, coalesce fell through to false, and every row was filtered out.

## Decision

Rewrite the function to read the user's email from the JWT claims directly, which is always available in the session and doesn't require querying any protected table:

```sql
CREATE OR REPLACE FUNCTION is_allowed_user() RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(
    (auth.jwt() ->> 'email') = 'andriosuroyo@gmail.com',
    false
  );
$$;
```

This is the Supabase-recommended pattern for JWT-claim checks. It's also faster (no table lookup) and doesn't need `SECURITY DEFINER` to escalate privileges.

## Consequences

- **The migration file `supabase/migrations/0001_init.sql` was updated on 2026-05-14 to use the JWT-based check directly,** so future clean installs are correct out of the box. The live database had already been patched via a one-off `CREATE OR REPLACE` earlier the same day; re-running the init migration anywhere else now produces the same fixed function.
- The function now hardcodes a single email. To support multiple users later, change the comparison to `IN (...)` or read from a config table. The `ALLOWED_USER_EMAIL` env var is enforced at the app layer (middleware), not the database layer — they would have to be kept in sync if expanded.
- The `auth.jwt()` call works for any signed-in user. Anonymous/unauthenticated callers get NULL back, and the coalesce returns false, correctly blocking access.

## How to verify

```sql
-- Should return TRUE when called by andriosuroyo@gmail.com's session
SELECT is_allowed_user();

-- Should return rows when called by andriosuroyo@gmail.com
SELECT * FROM shipping_methods LIMIT 1;
```
