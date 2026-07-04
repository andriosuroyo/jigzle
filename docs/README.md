# docs/

Code-coupled documentation. Notes that live alongside the code in git.

## What goes here

- **Architecture decision records (ADRs)** — significant choices that future-you (or AI) will need to understand. Example: "Why we use Frankfurter and not Open Exchange Rates."
- **Schema notes** — anything not obvious from `supabase/migrations/`. Why a column exists, why a constraint is shaped a certain way.
- **Formula explanations** — when the math in `packages/lib/` has non-obvious reasoning behind it. The forwarder-tax-included logic is a good example: it's a one-line `IF` in code, but the *why* is worth a paragraph.
- **Runbooks** — recovery procedures, e.g., "If FX rates haven't refreshed in 24 hours, do X."

## What does NOT go here

- **Design specs and visual mockups** → Google Drive (`Jigzle CIS — Mobile Sheet.html`, `Jigzle Calculator.html`, the build guide, etc.).
- **Operational data** → Supabase tables or the existing Drive folders for jigzle.drive@gmail.com.
- **Generic Next.js or Supabase how-tos** → the official docs are better than anything we'd write here.

Rule of thumb: if a future change to this repo's *code* depends on understanding it, document it here. If it's a design or operational reference, keep it in Drive.

## App sitemap

[`sitemap.html`](./sitemap.html) is a self-contained, offline-openable map of the whole ops app — every route, tab, button, dropdown, and modal, grouped the same way the app's own nav is. It's a shared reference for pointing at the exact part of the app under discussion. Open it in a browser (no build step); update it alongside UI changes — see the maintenance comment at the top of the file.

## ADR template

When adding a decision record, name files `001-<short-slug>.md`, `002-<...>.md`, etc. Each should have:

```
# 001 — Title

**Date:** YYYY-MM-DD
**Status:** Accepted | Superseded by 0NN | Reversed

## Context
What problem were we solving? What constraints were in play?

## Decision
What did we choose?

## Consequences
What does this lock us into? What did we give up? What else now becomes easier or harder?
```

Short is fine. The point is future-readability, not exhaustive prose.
