# JZ-001 · Orders pipeline window
**Status:** Ready to build · **Build in:** `jigzle` repo · **PR:** — · **Created:** 2026-06-26 · **Updated:** 2026-06-26 (label decided)

## Goal / outcome
Replace the four separate sell-side hub cards (New, Pending, Fulfill, Outbound) with a single **Orders** window that presents the order lifecycle as pipeline tabs — **Pending → Fulfill → Outbound**, plus **History** — each with a live count badge, and a persistent **"+ New order"** button. Outcome: the whole sell-side flow lives in one place with at-a-glance per-stage counts, and an order moves forward without bouncing back to the hub. **Presentation/navigation only — no schema, RPC, or migration changes.**

## Context / why
The hub currently shows New, Pending, Fulfill, Outbound as separate islands, even though they're consecutive stages of one order's life. Combining them surfaces the pipeline and removes hub round-trips. They are *not* the same shape, though: **New** is a creation form; **Pending / Fulfill / Outbound** are identical work-queues (a list of orders at a stage → open one → do the stage action → it advances). So the tabs are the three queues; New is a button, not a tab. (See conversation 2026-06-26.)

## Scope
**In:** front-end navigation + screen composition.
**Out (unchanged):** DB schema; stage RPCs (`create_order`, cut/`stock_check`, fulfill, outbound/ship, `mark_order_paid`, `unfulfill_order`); per-stage business logic. Each existing stage screen is reused as a tab panel. **No migration.**

## Build parts
*(Single build, but staged so it can ship incrementally if wanted.)*

### Part 1 — Route + tab shell
- New route `/orders` with a top segmented tab bar in pipeline order: **Pending → Fulfill → Outbound → History**.
- Each existing stage screen (`/sales` list view, `/fulfill`, `/outbound`, History) mounts as that tab's panel — reuse as-is, no logic changes.
- Keep `/sales`, `/fulfill`, `/outbound` as **redirects** into the matching tab (muscle memory + deep links).
- Default tab on open = **Pending**.

### Part 2 — "+ New order" + hub collapse
- Persistent **"+ New order"** button in the Orders window header (not a tab). Opens the existing create-order flow; on save the order lands in **Pending**.
- Update `navConfig` + the hub: the four cards collapse into one **"Orders"** card; History's separate card is removed (now a tab). Buy-side (Purchasing → Inbound) untouched.

### Part 3 — Pipeline affordances
- **Count badge** per tab (live).
- Completing a stage action **advances** the order to the next stage's list and updates counts, but **does not auto-switch tabs** (jarring on mobile) — show a toast: *"Order #1234 → Fulfill."*
- **Payment status** renders as a row badge (Need payment / DP / Paid) within whatever stage the order is in; settling logic unchanged.
- Opening an order is a detail view layered over the current tab; back returns to the same tab + scroll position.

## Decisions (flippable)
- History = 4th tab inside Orders (vs its own card).
- Default tab = Pending (vs remember-last-used).
- No auto tab-switch on stage advance (toast only).
- "+ New" = header button (vs a peer tab).
- Tab labels = **Pending / Fulfill / Outbound** (kept; "Pending" reads as a status, the others as actions). Decided 2026-06-26.

## Open questions
- None — ready to build.

## Changelog
- 2026-06-26: Created. Direction chosen = pipeline tabs (Pending/Fulfill/Outbound) + New button + History tab.
- 2026-06-26: Tab-label decided — keep "Pending" (not "Cut"). No open questions; fully ready to build.
