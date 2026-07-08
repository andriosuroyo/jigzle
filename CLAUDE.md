# Jigzle — repo guide for Claude

Monorepo (npm workspaces + turbo). The main app is **`apps/ops`** (Next.js 14 App Router,
Supabase). Shared packages live under `packages/*` (`@jigzle/db`, `@jigzle/lib`, `@jigzle/ui`).

## Development workflow — pool changes, ship on command

Do **not** auto-merge every unit. **Pool** small changes on the feature branch and ship them in
batches; the user decides when they go live. For every unit of work:

1. **Branch.** Work on the designated feature branch (never commit straight to `main`).
2. **Verify — the merge gate.** From each app dir touched (e.g. `apps/ops`):
   - `../../node_modules/.bin/tsc --noEmit`
   - `../../node_modules/.bin/next build` (also runs ESLint)
   Both must pass before anything merges — a red build must never reach `main`. (`npm install` at
   the repo root first if deps are missing.)
3. **Commit + push to preserve — but hold the merge.** Commit the unit and push the branch. The
   push costs nothing (Vercel skips all non-`main` builds — see Deploy facts), so it safely
   preserves work against container reclaim and keeps the Stop hook quiet. Do **not** open/merge a
   PR yet for a small change.
4. **Ship when signalled.** Open the PR + squash-merge **only** when the user says "ship it" — OR
   immediately when the change is genuinely **big** (≳300 changed lines, or a full screen/nav
   redesign). Pool guardrail: don't let a batch exceed ~800 lines or blend unrelated areas.
   - **PR sequence:** number each PR as the next in sequence (last is #52 → this is `PR53`); code
     comments reference work by that number.
   - **Merge = squash-merge into `main`.** That is the only thing that deploys.
5. **After the squash-merge: the empty-commit resync** (the dedicated note just below). Mandatory —
   it is what keeps *both* the Vercel production deploy and the Stop hook healthy.

**Deploy facts (Vercel, Hobby plan) — the hard-won rules, so a fresh session doesn't relearn them:**
- **Only `main` builds.** An **Ignored Build Step** (Vercel → Settings → Build and Deployment:
  `if [ "$VERCEL_GIT_COMMIT_REF" = "main" ]; then exit 1; else exit 0; fi`) skips every branch push.
  So a PR showing a Vercel **"Ignored"** deployment is EXPECTED — it is **not** a production stall.
- **Production deploys on merge to `main`**, automatically (no deploy command) → `jigzle.vercel.app`.
- The Hobby **100-deploys/day** cap (`api-deployments-free-per-day`) is now only touched by `main`
  merges (previews are skipped), so it won't bite at a normal cadence. It's a rolling 24h window;
  if you ever hit it, wait it out or retry. Do **not** re-create the deleted **`jigzle-calculator`**
  Vercel project — it was a duplicate wired to this repo that once doubled the deploy volume.
- The ops app is a PWA (no service worker; staleness handled by `Cache-Control: no-store` on
  documents, PR232) — after a prod deploy a hard reload may still be needed to drop a cached bundle.
- Destructive/irreversible beyond a normal code deploy (DB migrations, data backfills, deleting or
  renaming things you didn't create) — confirm with the user first.
- **After the squash-merge, resync to `main`, then put ONE empty verified commit on the branch and
  push that** — do **NOT** force-push the branch to main's exact merge SHA:
  ```
  git fetch origin main && git checkout -B <branch> origin/main \
    && git commit --allow-empty -m "sync: track main after PR merge" \
    && git push --force-with-lease origin <branch>
  ```
  This keeps `origin/<branch>` == local `HEAD` (so `origin/<branch>..HEAD` is empty and the **unpatched**
  Stop hook passes — no "Unverified"/"unpushed" false positive), while the branch tip is a **different
  SHA from main's merge commit**. That difference is the whole point (see below).
  - **Why the branch SHA must differ from main's (PR242 → PR247 → PR252 — the real rule).** Vercel
    **deduplicates deployments by commit SHA** and, with the **Ignored Build Step** on
    (Vercel → Settings → Build and Deployment: `if [ "$VERCEL_GIT_COMMIT_REF" = "main" ]; then exit 1;
    else exit 0; fi` — only `main` builds), **every branch push still creates an "Ignored" deployment
    record for its SHA.** If you force-push the branch to main's merge SHA, that Ignored record claims the
    SHA, and main's push to the *same* SHA gets **deduped → the production build never runs** (this
    stranded PR250 & PR251 at PR249). Keeping the branch on `main + empty commit` leaves main's merge SHA
    **uncontested**, so production deploys reliably. (PR247 wrongly assumed the Ignored Build Step made the
    same-SHA force-push safe — it doesn't; an Ignored deployment still dedupes.)
  - **Do NOT hand-patch `~/.claude/stop-hook-git-check.sh`.** The harness restores it to the unpatched
    version every turn, so edits never hold. The empty-commit push above makes the *unpatched* hook pass
    by construction (`origin/<branch>` == `HEAD`), and the empty commit is authored by
    `noreply@anthropic.com` so it's never flagged as Unverified even if it lands in a range.

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
- **Detail action-bar layout (PR239) — one standard everywhere.** A detail view's action row is a single
  **left-aligned, horizontally-scrollable** row (it *slides* on mobile, never wraps): `display:flex;
  gap:8px; overflow-x:auto` with `> button { flex-shrink:0 }`. Order the buttons **secondary → primary →
  destructive**, all grouped together on the left; the destructive button is simply **last in the group**
  — never pushed to the far edge with `margin-left:auto`. Reference impl: `.fd-actions` (Sales → Pending);
  `.td-actions` (Purchasing → To buy), `.ob-return` (History), `.fd-commit-row` (Fulfill) all follow it.

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
