# 006 — Receiving (Inbound) Module — Spec for Redline

**Date:** 2026-06-16 · **Status:** LOCKED — decisions D1–D4 resolved (§4); cleared to build.
**Plan item:** J2 (the "+" side of stock — completes the loop).
**Depends on:** `apps/ops`, migrations `0003`–`0014`, `stock_check`, `inbound`, `shipments`, `purchase_orders`, `barcodes`.
**Builds on:** Sales pipeline (003–005). Those cut stock down; this is the only module that adds it.

Until this exists the imported `inbound` is a frozen baseline — every new arrival is invisible
to the engine and `available`/`physical` drift from reality. Receiving records arrivals into
`inbound`, so `available` and `physical` rise and `last_receive` updates.

---

## 1. What this module does (and does not)

**Does:** show arriving shipments, let the operator open one, scan or check each item to a SKU,
cross-check what physically arrived against what was expected (flag missing / extra / short),
and save — appending rows to `inbound`, closing the shipment, and (optionally) marking the
matching purchase orders received.

**Stock effect:** each `inbound` row with `excluded = false` raises `available` and `physical`
by its qty; `last_receive = max(receive_date)`. `qty` is **signed** — a negative row is a stock
correction (supported, not just receipts).

**Does not:**

- **No procurement.** It doesn't create purchase orders — it receives against existing ones.
  The full Procurement module (supplier bridges, doc generation) is later.
- **No full catalogue management.** Unknown barcodes get a *minimal* SKU stub flagged for admin
  review (decision D2); proper catalogue editing stays its own surface.

---

## 2. Screen flow

Two-pane, same shape as the others: arrivals queue (left) + receive detail (right).

```
┌──────────────────────────────┬───────────────────────────────────────────┐
│  ARRIVALS (shipments: open)   │  RECEIVE  SUB 191  ·  China · 2026-06-10    │
│                               │  expected 7 items                            │
│  ▸ SUB 191   China  7 items   │                                             │
│  ▸ IMA 1023  Japan  3 items   │  scan / add: [ 4959295043581____ ]  [add]   │
│  ▸ (ad-hoc receive +)         │   ⚠ barcode → 2 SKUs: ◉ APP-300-358         │
│                               │                       ○ ENS-300-358  [pick] │
│                               │                                             │
│                               │  EXPECTED vs RECEIVED                        │
│                               │  ✓ TEN-DS-1000-764 Mt Fuji  exp 2 · got 2   │
│                               │  ⚠ RAV-300-112    Cats      exp 3 · got 1   │
│                               │  ⚠ EPO-12-009     (extra)   exp 0 · got 1   │
│                               │  ✗ SUNT-500-04    Reef      exp 1 · got 0   │
│                               │                                             │
│                               │  per line: qty · ☐ exclude · label[ ▾ ] ·  │
│                               │            dim/weight (optional)            │
│                               │  unknown barcode → [ + add new SKU ]        │
│                               │  receive date [ 2026-06-16 ]                │
│                               │            [ Save receipt ]                  │
└──────────────────────────────┴───────────────────────────────────────────┘
```

**Queue (left):** `shipments` with `status = 'open'` (no `received_date`). Row: `ship_id`,
`origin_country`, `ship_date`, expected item count (from `contents`). Plus **+ ad-hoc receive**
for goods with no ledger entry — the legacy `📦YYMMXXX` case (decision baked, see §4).

**Detail (right):**

- **Expected list:** built from the shipment's `contents` jsonb `[{qty,item}]` and (per D3) the
  `purchase_orders` whose `ship_id` matches.
- **Scan / add:** a barcode field resolves via `barcodes` → SKU and increments that line; manual
  SKU search also adds a line.
  - **Collision (D1):** a barcode mapping to >1 SKU (the 72+5 known collisions) shows a "which
    SKU?" picker instead of guessing.
  - **Unknown barcode (D2):** offers **+ add new SKU** — a minimal stub (item_code by the brand
    prefix convention + name) flagged for admin review; missing dimensions can be filled now or
    later.
- **Expected vs received:** live badges per line — ✓ match · ⚠ short (exp > got) · ⚠ extra
  (got, not expected) · ✗ missing (expected, not received).
- **Per line:** qty received, an **exclude** toggle (gift/damaged → 0 sellable), a **label**
  (`Exclude`/`Hold`/`Tokopedia`), optional dimension/weight (raw text).
- **Receive date:** defaults to today.

**On Save receipt** (one atomic RPC — §3):

1. insert one `inbound` row per received line (`item_code`, signed `qty`, `ship_id`,
   `receive_date`, `excluded`, `label`, `dimension_weight`, `tracking` from the shipment).
2. if `ship_id` matches a `shipments` row → set `received_date = today`, `status = 'completed'`.
3. if D4 = yes → mark matching `purchase_orders` (same `ship_id` + item) `status = 'Received'`,
   stamp their `receive_date`.
4. return affected `item_code`s so the screen refreshes stock.

Partial receive allowed: save what arrived; shorts/missing stay visible. A shipment with items
still outstanding can be left `open` (decision baked — close only when the operator confirms).

---

## 3. Proposed file changes

### Migration — `0015_receiving.sql`

- A `record_receipt` **RPC**, `SECURITY INVOKER`, pinned `search_path` (same pattern as the
  other three RPCs). Signature ~
  `record_receipt(p_ship_id text, p_receive_date date, p_lines jsonb, p_close_shipment bool)` →
  inserts `inbound` rows from `p_lines` (`[{item_code, qty, excluded, label, dimension_weight}]`);
  if `p_close_shipment` and `p_ship_id` matches `shipments` → set `received_date`/`status`;
  if D4 → update matching `purchase_orders`; return affected `item_code`s.
- **If D2 = yes:** add `catalogue.needs_review boolean not null default false` (additive) so
  receive-time SKU stubs surface in an admin queue.
- **If D1 ad-hoc id is generated:** an advisory-lock counter for the `📦YYMMXXX` form (same
  safety as the `JZ-`/`SND-` allocators).

### New files — `apps/ops`

| File | Purpose |
|---|---|
| `app/receiving/page.tsx` | server shell: load the arrivals queue, render `<ReceivingBoard/>` |
| `components/ReceivingBoard.tsx` | client: queue + receive detail per §2 |
| `app/receiving/actions.ts` | `getReceiveQueue()`, `getShipmentForReceive(shipId)`, `resolveBarcode(code)` (handles collisions), `createCatalogueStub(input)`, `recordReceipt(payload)` |
| `app/page.tsx` | add `/receiving` to the hub nav (Sales · Fulfill · Outbound · Receiving) |

### Changed files — packages

| File | Change |
|---|---|
| `packages/db/src/types.ts` | add `Inbound`, `Shipment`, `ReceiveQueueRow`, `ReceiveLine`, `ExpectedLine` |
| `packages/lib/src/ids.ts` | add the `📦YYMMXXX` ad-hoc ship-id generator (if D1 ad-hoc = generate) |

### Out of scope

Full Procurement (PO creation, supplier bridges, invoice/packing-list generation), proper
catalogue editing/admin-review UI (Receiving only *flags* stubs), the picture pipeline.

---

## 4. Decisions — LOCKED (2026-06-16, via AskUserQuestion)

- **D1 — Barcode collisions.** ✅ **"Which SKU?" picker, proceed.** A barcode mapping to >1 SKU
  prompts the operator in-flow; Receiving is not blocked on the 72+5 cleanup.
- **D2 — Unknown barcode.** ✅ **Inline minimal new-SKU stub**, flagged `needs_review` (adds
  `catalogue.needs_review` in `0015`); admin completes the SKU later.
- **D3 — Expected list source.** ✅ **Shipment `contents` + `purchase_orders` by `ship_id`** —
  reconcile against both.
- **D4 — PO status on receive.** ✅ **Auto-mark matching POs `Received`** (+ stamp
  `receive_date`).

**Baked defaults (matching schema/legacy, flag if you disagree):** ad-hoc receive supported
(generate a `📦YYMMXXX` id, operator can override with free text); `excluded` + `label` captured
per line; signed qty allows negative stock-correction rows; partial receive allowed (shipment
closes only on operator confirm).

---

*Once §2 is redlined and §4 locked: migration `0015` (the `record_receipt` RPC + any flag) →
types + ids → `apps/ops` `/receiving` route + actions. Handed to Claude Code via a build prompt.*
