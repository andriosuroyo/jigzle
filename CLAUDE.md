# Jigzle — repo guide for Claude

Monorepo (npm workspaces + turbo). The main app is **`apps/ops`** (Next.js 14 App Router,
Supabase). Shared packages live under `packages/*` (`@jigzle/db`, `@jigzle/lib`, `@jigzle/ui`).

## Default development workflow — "ship every build"

When a unit of work is complete, **ship it end-to-end without waiting to be asked** — push,
merge, deploy. Concretely, for every build:

1. **Branch.** Do the work on a feature branch (never commit straight to `main`).
2. **Verify locally (the merge gate).** For each app touched, run from its directory
   (e.g. `apps/ops`):
   - `../../node_modules/.bin/tsc --noEmit` (typecheck)
   - `../../node_modules/.bin/next build` (production build — also runs ESLint)
   If deps aren't installed yet, run `npm install` at the repo root first.
   **Only proceed if both pass.** A red build must never reach `main`.
3. **PR.** Open a pull request into `main` with a clear title + body. The PR gives a paper
   trail and a Vercel **preview** deployment URL. **Continue the PR sequence:** before
   opening, check the repo's most recent PR number and number this work as the next one
   (e.g. last is #52 → this is #53). Code comments reference work by that number (`PR53`).
4. **Merge.** Once the gate is green, **squash-merge the PR into `main` automatically** — no
   need to ask first. (This is the standing instruction; it overrides the usual
   "don't merge without asking".)
5. **Deploy.** Deployment is automatic via Vercel's Git integration — there is **no deploy
   command** to run. Merging to `main` triggers the **production** deploy
   (`jigzle.vercel.app`); each branch/PR gets a **preview** deploy.

Notes:
- If the local build/typecheck fails, stop and fix it — do not merge. Report the failure.
- The ops app is a PWA with a service worker, so after a production deploy a hard reload (or
  reopening the installed app) may be needed to drop the cached old bundle.
- This auto-merge default applies to ordinary builds. For anything destructive or
  irreversible beyond a normal code deploy (DB migrations, data backfills, deleting/renaming
  things you didn't create), still confirm with the user first.
- **After the squash-merge, keep the branch and its remote in lock-step.** The squash creates a
  *new* commit on `main` (authored by `GitHub <noreply@github.com>`). If you resync the feature
  branch to it (`git fetch origin main && git checkout -B <branch> origin/main`) but leave
  `origin/<branch>` pointing at the old pre-merge commit, then `origin/<branch>..HEAD` contains
  GitHub's merge commit — a commit you didn't author locally — and the Stop hook flags it as
  "Unverified" (a false positive). **Fix: right after the resync, also push the branch so the
  remote matches** — `git push --force-with-lease origin <branch>` (force-with-lease is correct
  here: the branch holds only already-merged history). That leaves `origin/<branch>..HEAD` empty
  and the hook has nothing to flag. Do this every time, so a turn never ends with the local branch
  ahead of its remote by GitHub's merge commit.

## Conventions

- Server data access goes through server actions (`'use server'`) using the SSR Supabase
  client; RLS (`is_allowed_user()`) gates reads/writes. Don't use the service-role key in app code.
- **Mutation actions awaited by button handlers must return errors as data**
  (`Promise<{ error: string | null }>`), never `throw` for expected failures — Next.js redacts
  thrown Error messages in production, so the UI would only show the opaque "An error occurred in
  the Server Components render" banner (PR145). Read-only loaders may still throw.
- The primary nav is a single source of truth in `apps/ops/components/navConfig.tsx`
  (consumed by both the hub landing page and `AppHeader`).
- Match the surrounding code's style, comment density, and naming when editing.
- **Button colour system (PR234) — role-based, never ad hoc.** Pick a button's colour from its role,
  not per request:
  - **Orange** (`btn-primary`) — the ONE primary CTA of a view/overlay (Save, Send to Outbound, Send
    ready items, Done buying, and the *commit* button of an add form).
  - **Brown** (`btn-brown`) — affirmative **secondary** actions: positive things that aren't the primary
    and aren't destructive (Mark as paid, Send back to pending, and every "+ New / + Add" **entry** button
    that opens an add form — New order, New item, Add note, Add item, Add address, Add supplier, …).
  - **White** (`btn-secondary`) — genuinely neutral / low-stakes (Change, Cancel, Edit, close).
  - **Red** — destructive. Two shades: the *opener* on a detail view is a red **outline** (`btn-danger`
    / `TrashButton`) — a caution that's safe to tap; the *confirm commit* inside the dialog is **solid**
    red (`btn-primary danger`, via `ConfirmModal danger`) — the actual irreversible step. "Mark as out of
    stock" stays a red-tinted secondary (`btn-secondary danger`) — a cautionary state change, not a delete.
  Icon convention: reserve a bare leading **"+"** for the top-level **New order** entry; give secondary
  add buttons a meaningful icon instead (e.g. a notepad for Add note). Apply this to any new button;
  don't invent a per-request colour.

## Supabase migrations — how they get applied

**Claude cannot apply migrations itself in the web/remote environment.** Only
`NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are exposed — the service-role key
is a PostgREST/JWT credential, **not** a Postgres password, so there is no `psql`/DDL path from
the session (no `DATABASE_URL`, no DB password, no `supabase` CLI login). Therefore:

1. **Write the migration as a file** under `supabase/migrations/NNNN_name.sql` (next number in
   sequence), committed with the PR that needs it — this is the source of truth / paper trail.
2. **Also paste the SQL into the chat** so the user can run it in the **Supabase SQL Editor**
   (Dashboard → SQL Editor). Make the SQL **idempotent** (`if not exists`, `create or replace`,
   guarded seeds) so re-running is safe.
3. **Write the app code to degrade gracefully until the migration is applied** — a loader that
   reads a not-yet-created table/column must catch the error and return `[]`/null so the screen
   still renders (mirror `getExportCouriers`, which returns `[]` if `settings_export_couriers`
   is missing). Never let a missing column white-screen a page.

If a future session is given a real `DATABASE_URL` / DB password, it may apply migrations directly
with `psql`; absent that, follow the paste-the-SQL flow above.
