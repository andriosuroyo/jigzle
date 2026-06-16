# 005 — Outbound (Ship) Module — Spec for Redline

**Date:** 2026-06-16 · **Status:** LOCKED — §4 decisions + §5 send model (`send_id` column) resolved; cleared to build.
**Plan item:** J2 (Sales pipeline, step 5: ship / outbound).
**Depends on:** `apps/ops`, migrations `0003`–`0013`, the `stock_check` view, `outbound_shipments` + `boxes` (`0008`).
**Builds on:** `004-fulfill-module-spec.md` (Outbound ships the lines Fulfill committed).

This is the **second** stock cut. Fulfill set `fulfilled_at` (qty → `reserved`). Outbound sets
`shipped_at` — the box physically leaves the shelf, so `physical` and `reserved` both drop.
That closes the order → stock loop the migration was built to fix.

---

## 1. What this module does (and does not)

**Does:** show a "ready to ship" worklist (lines fulfilled-but-not-shipped), let the operator
open an order, optionally scan/check the items, record the physical **boxes** (weight + size →
chargeable weight), set the actual courier + tracking, and **mark shipped** — stamping
`shipped_at` and, when every line is out, flipping the order to `Complete`.

**The stock effect:** `order_lines.shipped_at = now()` drops `physical` (`inbound − shipped`)
and `reserved` (`fulfilled − shipped`) by that qty. `available` is **unchanged** (it already
dropped at fulfill). No double-count.

**Does not:**

- **No billing/reconciliation.** It only *captures* the per-box chargeable weight. The monthly
  TIKI invoice check stays in the `/jigzle-outboundcheck` skill (locked D-Billing). The
  `+300 g/kg` rounding belongs to that check, not here.
- **No re-fulfilling, no pricing.** A line must already be fulfilled to appear here.
- **No scan dependency.** Scanning is optional (locked) — the barcode collisions (72 + 5) are
  still being cleaned.

---

## 2. Screen flow

Two-pane, same shape as Fulfill: ship queue (left) + ship detail (right).

```
┌──────────────────────────────┬───────────────────────────────────────────┐
│  READY TO SHIP                │  SHIP  JZ-2606-0001  →  Andri               │
│  (lines fulfilled,            │  Jl. Merpati 12, Balikpapan …               │
│   shipped_at IS NULL)         │                                             │
│                               │  ITEMS (fulfilled, not shipped)             │
│  ▸ JZ-2606-0001  Andri        │  ☑ TEN-DS-1000-764 Mt Fuji ×1  [scan ____]  │
│      2 lines · JNE            │  ☑ RAV-300-112     Cats    ×2  [scan ____]  │
│  ▸ JZ-2606-0002  Budi         │     (scan optional — check to include)       │
│      1 line  · J&T            │                                             │
│                               │  BOXES                                       │
│                               │  Box 1  real [ 1200 ]g  P[34] L[10] T[34]   │
│                               │         ☐ bill by volume                     │
│                               │         vol 1927g · chargeable 1927g        │
│                               │  [ + box ]                                   │
│                               │                                             │
│                               │  Courier [ JNE ▾ ]  Tracking [ __________ ] │
│                               │                                             │
│                               │  Σ shipping 3 units · order will → Complete  │
│                               │            [ Mark shipped ]                  │
└──────────────────────────────┴───────────────────────────────────────────┘
```

**Queue (left):** orders that have lines with `fulfilled_at IS NOT NULL AND shipped_at IS NULL
AND NOT is_cancelled`. Row shows order, customer, ready-line count, planned courier (from
fulfill).

**Detail (right):**

- **Items:** the fulfilled-unshipped lines. Each has a checkbox (default checked) and an
  **optional** barcode field — scanning resolves via `barcodes` and ticks the line; manual
  check-off is allowed (locked). Partial ship allowed: only checked lines go.
- **Boxes:** add one or more boxes. Per box: `real_weight` (g), optional `P/L/T` (cm), a
  **bill-by-volume** toggle. The screen previews `vol_weight = ceil(P)·ceil(L)·ceil(T)/6000`
  and `chargeable_weight = max(real, vol)` (the RPC recomputes these authoritatively).
- **Courier + tracking:** default courier from fulfill, editable; actual tracking entered here.
- **Commit bar:** unit count + whether the order will reach `Complete`. **[Mark shipped]** runs
  the RPC.

**On Mark shipped** (one atomic RPC — §3):

1. create a **`send`** (one physical dispatch; see §5) and stamp `order_lines.shipped_at = now()`
   + courier + tracking on the checked lines.
2. write one `outbound_shipments` row **per shipped line** (one-row-per-SKU, locked), linked to
   the send + order line.
3. write the `boxes` under the send (with computed `vol_weight` / `chargeable_weight`).
4. if **all** non-cancelled lines of the order are now shipped → set `orders.status = 'Complete'`
   (locked; independent of payment_status — an unpaid-but-shipped order still reads `Partial`/
   `Unpaid` on its payment side).
5. return affected `item_code`s so the screen refreshes stock.

---

## 3. Proposed file changes

### Migration — `0014_outbound.sql`

- **Link/group columns (additive, all nullable so the 5,712 legacy rows are untouched):**
  - `outbound_shipments`: add `sales_id` (FK `orders`), `order_line_id` (FK `order_lines`),
    `send_id` (text — the dispatch group key, see §5).
  - `boxes`: add `send_id` (text). New boxes group by `send_id`; the existing
    `shipment_id` FK stays nullable and unused for new sends (no legacy boxes exist).
- **`record_shipment` RPC**, `SECURITY INVOKER`, pinned `search_path` (same pattern as
  `create_order` / `fulfill_order`). Signature ~
  `record_shipment(p_sales_id text, p_line_ids text[], p_courier text, p_tracking text,
  p_boxes jsonb)` →
  - allocate `send_id` (`SND-YYMM-####`, advisory-lock counter — same safety as the JZ ids);
  - `update order_lines set shipped_at = now(), courier, courier_tracking where line_id =
    any(p_line_ids) and fulfilled_at is not null and shipped_at is null and not is_cancelled`;
  - insert one `outbound_shipments` row per shipped line (sales_id, order_line_id, send_id,
    customer_id, item_code, qty, ship_date, address, courier);
  - insert `boxes` from `p_boxes`, recomputing `vol_weight`/`chargeable_weight` server-side;
  - if no unshipped non-cancelled lines remain → `update orders set status = 'Complete'`;
  - return affected `item_code`s.
  - No `orders.status` CHECK change — `Complete` is already in the enum.

### New files — `apps/ops`

| File | Purpose |
|---|---|
| `app/outbound/page.tsx` | server shell: load the ship queue, render `<OutboundBoard/>` |
| `components/OutboundBoard.tsx` | client: queue + ship detail per §2 |
| `app/outbound/actions.ts` | `getShipQueue()`, `getOrderForShip(salesId)`, `recordShipment(payload)` |
| `app/page.tsx` | add `/outbound` to the hub nav (Sales · Fulfill · Outbound) |

### Changed files — packages

| File | Change |
|---|---|
| `packages/db/src/types.ts` | add `OutboundShipment`, `Box`, `ShipQueueRow`, `ShipLine` |
| `packages/lib/src/weight.ts` *(new)* | `volWeight(p,l,t)` = ceil·ceil·ceil/6000, `chargeable(real,vol)` = max — for the client preview only; the RPC is authoritative. Export from `index.ts`. |

### Out of scope

DB-driven TIKI reconciliation (replacing the PDF skill), Sales↔Outbound history reverse-match
(phase 2), Receiving (the inbound "+" side, a separate module).

---

## 4. Decisions — LOCKED (2026-06-16, via AskUserQuestion)

- **Billing.** ✅ Capture per-box chargeable weight into the DB; **keep the
  `/jigzle-outboundcheck` skill** for the monthly TIKI check. No in-app reconciliation now.
- **Shipment model.** ✅ **One `outbound_shipments` row per SKU** (legacy shape) + `boxes` for
  the physical packaging. Implemented via the `send_id` group key — see §5.
- **Scan.** ✅ **Optional** barcode scan; manual check-off allowed.
- **Complete status.** ✅ **Flip `orders.status` to `Complete`** when every non-cancelled line is
  shipped. This is the one place the app writes `status` (Fulfill stayed timestamp-driven).

Inherited from Fulfill: **partial ship allowed** (per-line); the queue is derived from
`shipped_at`, not a status.

---

## 5. The send model — ✅ CONFIRMED: `send_id` column (2026-06-16)

"One row per SKU + boxes" has a structural gap: `boxes.shipment_id` points at a single
`outbound_shipments` row (one SKU), but a real box holds several SKUs. So a 3-SKU / 2-box
dispatch has nowhere clean to hang the boxes.

**Proposed fix (what `0014` does):** a lightweight **`send_id`** (a text group key like
`SND-2606-0001`, one per physical dispatch) added to both `outbound_shipments` and `boxes`.
The per-SKU outbound rows and the boxes of one dispatch share a `send_id`; an order shipped in
two partial dispatches gets two `send_id`s. No new table; legacy rows keep `send_id` NULL.

**Alternative** (heavier, cleaner long-term): a real `sends` parent table (`send_id` PK,
`sales_id`, `ship_date`, `courier`, `tracking`) that `outbound_shipments` and `boxes` both FK
to. Better normalized, but a new table and more wiring.

I recommend the **`send_id` column** approach (lighter, keeps your locked legacy shape). Confirm
that, or say if you'd rather the `sends` table — then this goes to Claude Code as a build prompt.

---

*Build order once §5 is confirmed: migration `0014` (columns + `record_shipment` RPC) → types +
`weight.ts` → `apps/ops` `/outbound` route + actions.*
