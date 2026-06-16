# 004 — Fulfill Module — Spec for Redline

**Date:** 2026-06-16 · **Status:** LOCKED — decisions D1–D6 resolved (§4); cleared to build.
**Plan item:** J2 (Sales pipeline, step 4 of draft→input→payment→**fulfill**→data).
**Depends on:** `apps/ops` (built, J2.1), migrations `0003`–`0012`, the `stock_check` view, `holds`.
**Builds on:** `003-sales-order-entry-spec.md` (order entry created the orders this module fulfills).

This is the step that finally moves stock. Order entry (D2 there) deliberately left
`fulfilled_at`/`shipped_at` NULL, so nothing entered so far has touched the stock numbers.
Fulfill is the first of the two stock cuts.

---

## 1. What this module does (and does not)

**Does:** show a worklist of paid orders waiting to go out, let the operator open one, check
each line against live stock, set the planned courier + shipping address, and **commit the
stock** — stamping `fulfilled_at` on the lines and auto-releasing any matching hold.

**The stock effect (the whole point):**

- Setting `order_lines.fulfilled_at = now()` moves that qty from **available** into
  **reserved** (`available` drops, `reserved` rises). `physical` is unchanged — the box is
  still on the shelf until Outbound ships it.
- Releasing a matching `holds` row (`released_at = now()`) raises `available` back by the
  hold qty. So a **held** item being fulfilled just converts a hold-reservation into a
  fulfill-reservation — no double count, no net `available` swing for that unit. Getting this
  right is the one subtle bit (see §3 RPC).

**Does not:**

- **No shipping.** `shipped_at` stays NULL — that is the **Outbound** module (next after this),
  which stamps `shipped_at` + weight + actual tracking and moves `reserved` → out the door.
- **No pricing, no payment edits** — those are upstream (order entry / a payment screen).

---

## 2. Screen flow

Two-pane: a worklist on the left, the selected order's fulfill detail on the right.

```
┌──────────────────────────────┬───────────────────────────────────────────┐
│  FULFILL QUEUE                │  ORDER  JZ-2606-0001                        │
│  (status = Need send,         │  Andri · Gold · WhatsApp                    │
│   has unfulfilled lines)      │                                             │
│                               │  Ship to:  ◉ Home – Jl. Merpati 12 …        │
│  ▸ JZ-2606-0001  Andri        │            ○ Office …      [ + new address ]│
│      2 lines · Paid · ✅ready  │                                             │
│  ▸ JZ-2606-0002  Budi         │  LINES                                       │
│      3 lines · Partial · ⚠1   │  ☑ TEN-DS-1000-764 Mt Fuji  ×1  avail 4     │
│  ▸ JZ-2606-0004  Sari         │  ☑ RAV-300-112    Cats      ×2  avail 9     │
│      1 line · Paid · ⚠ short  │     ⚠ hold #7 (this item, For: Andri)       │
│                               │        → will auto-release on fulfill        │
│  [ filter: ready only ]       │                                             │
│                               │  Courier:  [ JNE        ▾ ]                  │
│                               │  Tracking: [ __________ ] (optional now)    │
│                               │                                             │
│                               │  Σ committing 3 units · available after: ok │
│                               │            [ Fulfill selected lines ]       │
└──────────────────────────────┴───────────────────────────────────────────┘
```

**Worklist (left).**

- Default rows: orders with `status = 'Need send'` that still have lines with
  `fulfilled_at IS NULL AND NOT is_cancelled`.
- Each row: sales_id, customer, line count, payment status, and a **readiness badge** —
  ✅ ready (every line `available ≥ qty`), ⚠ N short (some lines short), ⚠ short.
- Filter toggle: "ready only" hides orders with any short line.
- Whether `Partial`/`Unpaid` orders appear here at all is **Decision D3**.

**Fulfill detail (right).**

- **Address:** radio list of the customer's `customer_addresses`, defaulted to the order's
  `address_id`; or **+ new address**.
- **Lines:** one row per unfulfilled line — checkbox (default checked when `available ≥ qty`),
  item_code, name, qty, and **live `available`** from `stock_check`. A short line
  (`available < qty`) shows an amber warning; whether the checkbox is blocked or just warned
  is **Decision D4**. Partial selection (fulfill some lines now, leave the rest) is
  **Decision D2**.
- **Matching holds:** for any line whose `item_code` has an active hold (and, if the hold
  names a customer, that customer), show it with "→ will auto-release on fulfill"
  (**Decision D6**).
- **Courier + tracking:** pick the planned courier; tracking optional at this step
  (**Decision D5**).
- **Commit bar:** shows how many units will be committed and the resulting `available`.
  **[Fulfill selected lines]** runs the transaction.

**On Fulfill** (one atomic RPC — see §3):

1. `order_lines.fulfilled_at = now()` on the checked lines; set `address_id`, `courier`,
   `courier_tracking` on them.
2. Release matching active holds (`released_at = now()`) — **D6**.
3. Order status: by default **unchanged** (stays `Need send`; the picking queue is derived
   from timestamps, not a new status) — **Decision D1**.
4. Return the updated stock for the affected SKUs so the screen refreshes the badges.

After commit, the order drops out of the queue (no unfulfilled lines left) or stays with its
remaining short lines if partial.

---

## 3. Proposed file changes

`apps/ops` already exists (J2.1). This adds one route + actions + one migration.

### Migration — `0013_fulfill.sql`

- A `fulfill_order` **RPC** (the atomic multi-row update + hold release; PostgREST can't do a
  multi-statement transaction, same reason `create_order` is an RPC). `SECURITY INVOKER`, so
  `is_allowed_user()` RLS still gates it. Signature roughly
  `fulfill_order(p_sales_id text, p_line_ids text[], p_address_id bigint, p_courier text,
  p_tracking text)` →
  - `update order_lines set fulfilled_at = now(), address_id, courier, courier_tracking
     where line_id = any(p_line_ids) and fulfilled_at is null and not is_cancelled`;
  - release holds: `update holds set released_at = now() where released_at is null and
     item_code in (the fulfilled lines' item_codes) [and customer match per D6]` — **release
     at most the fulfilled qty's worth** so we don't over-release;
  - if **D1 = add a status**, set it here;
  - return the affected `item_code`s (so the client re-reads `stock_check`).
- If **D1 = add a status**, also extend the `orders.status` CHECK (additive).

### New files — `apps/ops`

| File | Purpose |
|---|---|
| `app/fulfill/page.tsx` | server shell: loads the initial worklist, renders `<FulfillBoard/>` |
| `components/FulfillBoard.tsx` | client: worklist + detail pane per §2 |
| `app/fulfill/actions.ts` | server actions (below) |
| `app/page.tsx` | add a link/nav to `/fulfill` alongside `/sales/new` |

**Server actions in `app/fulfill/actions.ts`:**

- `getFulfillQueue(filterReadyOnly?)` → orders + per-line readiness (joins `orders`,
  `order_lines`, `customers`, `stock_check`). Could be a small SQL view if the query gets
  heavy; start as a query.
- `getOrderForFulfill(salesId)` → unfulfilled lines + live `available`, the customer's
  addresses, and matching active holds.
- `fulfillOrder(payload)` → calls the `fulfill_order` RPC; returns refreshed stock.

### Changed files — packages

| File | Change |
|---|---|
| `packages/db/src/types.ts` | add `Hold`, `FulfillQueueRow`, `FulfillLine` types |

No new `packages/lib` logic expected — readiness is `available ≥ qty`, computed from
`stock_check`.

### Out of scope

Outbound (ship: `shipped_at` + weight + box/volumetric + the TIKI billing feed) is the **next**
module, specced separately. Receiving (the inbound "+" side) likewise.

---

## 4. Decisions — LOCKED (2026-06-16)

- **D1 — Status on fulfill.** ✅ **Timestamp-driven, no status change.** `orders.status` stays
  `Need send`; the picking queue and Outbound worklist derive from `fulfilled_at`/`shipped_at`.
  No `orders.status` CHECK change.
- **D2 — Partial fulfillment.** ✅ **Allow per-line partial fulfill.** Fulfill the ready lines
  now; short lines stay in the queue.
- **D3 — Payment gate.** ✅ **Show + warn, allow override.** `Partial`/`Unpaid` orders appear in
  the queue with a warning; the operator can fulfill anyway.
- **D4 — Short stock.** ✅ **Warn + allow override.** `available < qty` is flagged but
  fulfillable; `available` may go negative (a real data-lag signal, not a crash).
- **D5 — Courier/tracking.** ✅ **Capture planned courier at fulfill** (tracking optional);
  Outbound can edit it and stamp the real tracking on ship.
- **D6 — Holds.** ✅ **Auto-release matching active holds on fulfill, capped at the fulfilled
  qty.** Converts a hold-reservation into a fulfill-reservation with no double count.

---

*Build order: migration `0013` (the `fulfill_order` RPC) → types → `apps/ops` `/fulfill` route
+ actions. Handed to Claude Code via the build prompt.*
