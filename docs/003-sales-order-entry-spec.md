# 003 — Sales Order-Entry Module — Spec for Redline

**Date:** 2026-06-16 · **Status:** LOCKED — decisions D1–D6 resolved (§4); cleared to build.
**Plan item:** J2.1 · **Scope:** the Sales order-entry screen only (shared login, no roles).
**Depends on:** migrations `0003`–`0011` (live), the `stock_check` view, `apps/calculator` auth pattern.

This doc proposes the screen flow and the exact file changes. Code gets written only after you sign off (or edit) the Decisions in §4.

---

## 1. What this module does (and does not)

**Does:** let one operator take a sales order start to finish, on one screen —
find or create the customer, see their loyalty tier, search SKUs, add lines with a
manual price, pick a shipping address, record a DP or full payment, and save the order.

**Does not (this module):**

- **No Fulfill / no stock cut.** Saving an order does **not** reserve or reduce stock.
  Stock is committed later in the Fulfill module (`fulfilled_at`) and shipped in Outbound
  (`shipped_at`). Here we only *read* `stock_check.available` to warn on low stock. This
  matches the pipeline (draft → input → payment → **fulfill** → data) and the rule that a
  line can't be reserved before it has arrived. See **Decision D2**.
- **No auto-pricing.** The operator types the price. Live pricing from scraped cost is
  phase-2.
- **No roles.** Same Google login as the calculator; single allowed user.

---

## 2. Screen flow

One page, five panels top-to-bottom. Each panel unlocks when the one above is done. The
right rail holds a running order summary that is always visible.

```
┌──────────────────────────────────────────────┬───────────────────┐
│  1. CUSTOMER                                   │   ORDER SUMMARY    │
│  ┌──────────────────────────────────────────┐ │   (sticky rail)    │
│  │ search: phone or name        [ search ]  │ │                    │
│  │ ── results ──                            │ │ Customer: —        │
│  │  • Andri (6281…) · Gold · Rp 6.2M        │ │ Tier:     —        │
│  │  • Andrew (6285…) · Bronze               │ │                    │
│  │  [ + New customer ]                      │ │ Lines:    0        │
│  └──────────────────────────────────────────┘ │ Subtotal: Rp 0     │
│  selected → loyalty readout chip               │                    │
│                                                │ Paid:     Rp 0     │
│  2. ITEMS                                      │ Balance:  Rp 0     │
│  ┌──────────────────────────────────────────┐ │                    │
│  │ SKU search: code / name / barcode        │ │ Status:   Need pay │
│  │ ── results (code · name · avail) ──      │ │                    │
│  │  TEN-DS-1000-764 · Mt Fuji · avail 4     │ │  [ Save order ]    │
│  │   qty [ 1 ]  price [ Rp ____ ]  [ add ]  │ │                    │
│  │ ── lines added ──                        │ │                    │
│  │  1× Mt Fuji      Rp 450k        [x]      │ │                    │
│  └──────────────────────────────────────────┘ │                    │
│                                                │                    │
│  3. ADDRESS   (pick from customer / + new)     │                    │
│  4. PAYMENT   ( ○ Full  ○ DP )  amount  method │                    │
│  5. REVIEW & SAVE                              │                    │
└──────────────────────────────────────────────┴───────────────────┘
```

**Panel 1 — Customer (the dedup gate).**

- Search box. Typing ≥2 chars queries by **normalized phone** (digits, `62…` form) and
  by **name** (case-insensitive contains). Results show name, phone, tier, lifetime spend.
- Click a result → selected. The loyalty readout chip appears (tier + Rp to next tier).
- **+ New customer** opens an inline form: name, phone, channel (dropdown of canonical
  values), and one address. On save it **normalizes the phone and checks the unique index**
  — if that phone already exists, it surfaces the existing customer instead of making a
  duplicate. See **Decision D6**.

**Panel 2 — Items.**

- SKU search queries `catalogue` by `item_code`, `self_code`, `original_name`,
  `translate_name`, and joined `barcodes.barcode`. Results show code, name, and
  **`available`** from `stock_check`.
- Add a line: qty + **manual price** + [add]. If `available ≤ 0` (or `< qty`) show an
  amber "low/again-order" warning but still allow it (backorder is normal here).
- Added lines list with per-line total and a remove [x]. No pictures yet (`catalogue.image`
  is null until the pictures phase).

**Panel 3 — Address.** Radio list of the customer's `customer_addresses`; or **+ new
address** (saved to that customer). Required before save.

**Panel 4 — Payment.** Toggle **Full** or **DP**. Enter amount + method (BCA / Shopee /
Tokopedia / Mandiri / Deposit / Website / Cash / Socmed). The rail shows Paid and Balance.
DP allowed; balance can be > 0 at save. See **Decision D5**.

**Panel 5 — Review & Save.** Save writes, in one transaction:

1. `customers` / `customer_addresses` rows if newly created.
2. one `orders` row — status derived (see D5), `sales_total_idr` = sum of lines.
3. one `order_lines` row per line (`fulfilled_at` / `shipped_at` left **NULL**).
4. one `payments` row for the DP or full amount (skip if zero).

On success: show the new order id + a compact summary, and a **[New order]** reset.

---

## 3. Proposed file changes

**Recommendation: a new app `apps/ops`** (the operational web app), separate from
`apps/calculator` (the import-costing tool). It reuses the existing packages and copies the
calculator's auth. Sales is its first route; Procurement / Receiving / Outbound / Dashboard
land beside it later. See **Decision D1** for the alternative (bolt routes onto the
calculator instead).

### New files — `apps/ops/`

| File | Purpose |
|---|---|
| `package.json`, `next.config.js`, `tsconfig.json`, `next-env.d.ts` | app scaffold (copy calculator's, rename) |
| `middleware.ts` | **copy** of calculator middleware (same `ALLOWED_USER_EMAIL` gate) |
| `app/layout.tsx`, `app/globals.css` | shell + styles |
| `app/login/page.tsx`, `app/auth/callback/route.ts` | **copy** of calculator Google-OAuth login |
| `app/page.tsx` | redirect to `/sales/new` for now (dashboard later) |
| `app/sales/new/page.tsx` | server component: thin shell, renders `<OrderEntry/>` |
| `components/OrderEntry.tsx` | client component: the whole 5-panel screen + summary rail |
| `app/sales/actions.ts` | **server actions** (the only DB writes) — see below |

**Server actions in `app/sales/actions.ts`:**

- `searchCustomers(q)` → `{id,name,phone,tier,lifetime_spend}[]`
- `createCustomer(input)` → upserts on normalized phone; returns the customer (existing or new)
- `getLoyalty(customerId)` → `{tier, lifetime_spend, to_next_tier}`
- `searchSkus(q)` → `{item_code,name,available}[]` (join `catalogue` + `barcodes` + `stock_check`)
- `createAddress(customerId, input)` → new `customer_addresses` row
- `createOrder(payload)` → the transactional write in §2 panel 5; returns `sales_id`

### Changed files — packages

| File | Change |
|---|---|
| `packages/db/src/types.ts` | add `Customer`, `CustomerAddress`, `Order`, `OrderLine`, `Payment`, `Catalogue`, `StockRow` types |
| `packages/lib/src/loyalty.ts` *(new)* | `tierFor(lifetimeIdr)` + `toNextTier(...)` — thresholds: Bronze 2.5%@2M · Silver 5%@4M · Gold 7.5%@6M · Platinum 10%@8M · Diamond 15% (top-N, phase-2) |
| `packages/lib/src/ids.ts` *(new)* | `sales_id` / `line_id` generators — see **Decision D3** |
| `packages/lib/src/index.ts` | export the two new modules |
| `packages/ui/src/*` | only if a shared Combobox / Table is worth extracting; default = keep them local to `OrderEntry.tsx` |

### Migration — `0012` (required; D4 + D5)

Two additive changes:

1. **D4:** add `order_lines.unit_price_idr bigint` (nullable) so manual price is stored per
   line; `orders.sales_total_idr` derives from the sum.
2. **D5:** alter the `orders.payment_status` CHECK to add `'Partial'`
   (`Paid / Unpaid / Partial / Cancel`). Additive — existing imported rows
   (Paid/Unpaid/Cancel) are unaffected; the importer's normalization is unchanged.

### Out of scope for this doc

The `shipped_at` importer bug (keys "Complete" off the order header instead of the line
status; J2.2) is a **data-lift fix in `scripts/import/`**, not a UI change. I'll spec/hand
that to Claude Code separately so it doesn't tangle with this module.

---

## 4. Decisions — LOCKED (2026-06-16)

- **D1 — Where it lives.** ✅ **New app `apps/ops`.** Reuses `@jigzle/db|lib|ui`, copies the
  calculator's Google-OAuth + middleware. Sales is its first route.
- **D2 — Stock cut.** ✅ **No cut at order entry.** Saving leaves `fulfilled_at`/`shipped_at`
  NULL; `available` is read-only info here, reduced later by the Fulfill module. Order is not
  reserved until Fulfill.
- **D3 — New order/line IDs.** ✅ **`JZ-YYMM-####`** for `sales_id` (counter restarts each
  month), `line_id = sales_id + "-" + n` (1-based). DB-generated, see `packages/lib/src/ids.ts`.
- **D4 — Line price.** ✅ **Add `order_lines.unit_price_idr`** (migration `0012`);
  `orders.sales_total_idr` = Σ(qty × unit_price).
- **D5 — DP / status.** ✅ **Add a real `Partial` status** (migration `0012` extends the
  `orders.payment_status` CHECK to `Paid / Unpaid / Partial / Cancel`). Mapping at save:
  full payment → `payment_status='Paid'`, `status='Need send'`; DP (0 < paid < total) →
  `payment_status='Partial'`, `status='Need payment'`; nothing paid → `Unpaid` / `Need payment`.
- **D6 — New-customer fields.** ✅ **Minimum:** name, phone, channel + one address. The rest is
  edited later.

---

*Build order: migration `0012` → types + `loyalty.ts`/`ids.ts` in `packages` → `apps/ops`
scaffold + auth → `OrderEntry.tsx` + `actions.ts`. Handed to Claude Code via the build prompt.*
