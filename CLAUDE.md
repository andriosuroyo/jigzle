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
   trail and a Vercel **preview** deployment URL.
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

## Conventions

- Server data access goes through server actions (`'use server'`) using the SSR Supabase
  client; RLS (`is_allowed_user()`) gates reads/writes. Don't use the service-role key in app code.
- The primary nav is a single source of truth in `apps/ops/components/navConfig.tsx`
  (consumed by both the hub landing page and `AppHeader`).
- Match the surrounding code's style, comment density, and naming when editing.
