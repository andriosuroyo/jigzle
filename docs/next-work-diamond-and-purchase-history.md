# Next work — Diamond tier + Purchase history

Planning notes (not yet built). Captured 2026-06-30 while the address parse ran.

## 1. Diamond tier (top-N, configurable; default 20)

**Already designed.** `packages/lib/src/loyalty.ts` documents Diamond as a phase-2 stub:
*"15% — top-N customers, not threshold-based, so not computed here. tierFor never returns 'Diamond'."*
The five-band ladder (Bronze 2.5% → Platinum 10%) is spend-threshold based; **Diamond is rank-based**
(the N highest-spending customers), 15% discount.

### Plan
- **Store N** in `pricing_config` (the existing single-row global config table, 0008). Add
  `diamond_count int not null default 20` via a new migration. Single source of truth.
- **Compute the Diamond set** = the top-N `customer_id` by `customer_lifetime.lifetime_paid_idr`
  (the same view that drives the directory tiers, 0037), descending. A small server helper
  `diamondCustomerIds()` returns the set; callers overlay it on the spend-based tier:
  `tier = isDiamond ? 'Diamond' : tierFor(spend).tier`.
- **Apply the overlay everywhere a tier is shown/used:**
  - `app/customers/actions.ts` → `initialTiers` (directory quickview) and `getCustomerDetail`
  - `app/sales/actions.ts` → `getLoyalty` (order entry discount) — Diamond ⇒ 15% off
  - `toNextTier`: Platinum customers not in the Diamond set should read "Top tier" (unchanged); a
    Diamond customer is top.
- **Settings UI** (`/settings`): a number input "Diamond tier size" (default 20), writing `pricing_config`.
- CSS: a `.tier-diamond` chip already implied by `tier-${tier.toLowerCase()}` — add the style.

### Decisions (locked 2026-06-30)
- **Selection basis:** PURE top-N by lifetime spend, regardless of amount.
- **loyalty_exclusions:** excluded customers are SKIPPED when ranking the top-N.
- **Ties at the boundary** (Nth vs N+1th identical spend): deterministic tiebreak by customer_id
  (effectively "at least N").

## 2. Purchase history (per customer, below Addresses)

A new section in the customer detail pane (`CustomersBoard.tsx`), under the addresses block.

### Behaviour
- **Per ORDER, not per item.** One card per `orders` row for the customer, newest first.
- **Order card shows:** order ID (`sales_id`, matches Sales), order date (`order_date`), order total
  (`sales_total_idr`), and item count.
- **Expand a card** → the order's `order_lines` rendered as item cards: small image (left) ·
  SKU + name · qty. Date is per order (on the card header), not per line.
- **Item card** reuses the existing look: `useSkuImages` + `sku_image_resolved` for the thumbnail,
  `catalogue` for name; lines with no `item_code` (legacy free-text) show `item_code_raw` + placeholder.

### Plan
- Server action `getCustomerOrders(customerId, { limit, offset })` → orders + per-order line summary
  (count + Σqty), lines fetched lazily on expand (or eagerly for the page of orders shown).
- Render below the addresses section; collapse/expand per order.

### Decisions (locked 2026-06-30)
- **Volume:** RECENT N (≈20) + "load more" paging back. Big customers (Henny: 785 orders) load fast.
  `getCustomerOrders(customerId, { limit, offset })`.
- **"Number of items":** Σ `qty` (sum of line quantities).
- **Order total:** `sales_total_idr` (order value).
- **Cancelled orders:** SHOW them, with a visual "Cancelled" marker (status already on the row).
