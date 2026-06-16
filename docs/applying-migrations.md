# Applying Supabase migrations

How to apply schema migrations to the `jigzle` Supabase project (formerly `jigzle-calc`).
Project ref: `tocmwitawwtxmnwrbyab` (confirm in Settings → General → Reference ID).

## Before you start
- **Project ref:** Settings → General → Reference ID (also in the project URL).
- **DB password:** Settings → Database → Database password (Reset it there if unknown).

## Primary path — Supabase CLI (reproducible)

Note the gotcha: `0001`/`0002` were applied OUTSIDE the CLI, so the remote migration history
doesn't record them. Mark them as applied first, or `db push` will try to re-run them (and
`0002` is seed data).

```bash
# one-time setup
supabase init                                        # creates supabase/config.toml; keeps migrations/
supabase login                                       # browser auth
supabase link --project-ref tocmwitawwtxmnwrbyab     # paste DB password if prompted

# tell the CLI 0001/0002 are already live
supabase migration repair --status applied 0001 0002

# apply only the new ones
supabase db push                                     # applies 0003–0009
```

Interactive moments: `supabase login` opens a browser (log in + approve); `link`/`push` may
ask for the database password.

The new migrations are additive (`create table if not exists` + the stock_check view) and never
touch the calculator tables (`currencies`, `shipping_methods`, etc.), so this is safe for the
live Calculator.

## Fallback path — Dashboard SQL editor (no install)

Supabase dashboard → SQL Editor → New query. For each file in order, paste its full contents
and Run:

`0003_catalogue.sql` → `0004_customers.sql` → `0005_sales.sql` → `0006_inbound.sql` →
`0007_procurement.sql` → `0008_pricing.sql` → `0009_stock_view.sql`

(Skip `0001`/`0002` — already applied.)

## Verify

Table Editor shows the 23 new tables; Database → Views shows `stock_check`. Or via CLI:
`supabase db pull` / a quick `select` against the remote.

## After applying
- Put the real `service_role` secret (Settings → API) into `.env.local` as
  `SUPABASE_SERVICE_ROLE_KEY` (gitignored; never a NEXT_PUBLIC var) — the data-lift importer needs it.
- Then run the data lift: `docs/session2-data-lift.md`.
