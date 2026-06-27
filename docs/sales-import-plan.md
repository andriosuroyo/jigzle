# Sales + Customer backfill — analysis & plan

Prep for the next round (reconcile scripts + one migration). Source CSVs: **Sales Data** (recent),
**Backup Sales** (older), **Customer Data**.

## Data shape (from the real exports)

| File | Orders | Span | Row format |
|---|---|---|---|
| Sales Data | 3,894 | 2020→2026 | `📦 Total items N` **header row** (carries the order total) + **per-item rows** (code + qty, no price) |
| Backup Sales | 13,621 | 2015→2023 | per-item rows; **total on the first row** (older style) |
| Customer Data | 7,768 (5,754 with `(id)`) | — | name+id, phone, channel, multiline address; **LIFETIME SPEND columns empty** |

Dates overlap 2020–2023 between the two sales files → **dedupe by `sales_id`** (Sales Data wins).

**Key insight:** the "per-item → per-batch" change was about **pricing granularity, not item detail**.
Both eras keep per-item **code + qty** rows, so `order_lines` populate for all 11 years and **stock
depletes correctly across the whole history**. The only thing the new era drops is the *per-item price*
(the money is one order-level total that already bakes in discounts/rounding).

## Locked decisions (AUQ)

1. **Pricing** — order total → `orders.sales_total_idr`; `order_lines.unit_price_idr` filled for old
   per-item orders, **NULL** for batch-era orders. No back-allocation.
2. **Stock cuts** — derive `fulfilled_at` / `shipped_at` on `order_lines` from STATUS / FULFILL DATE so
   historical sales reduce `available`.
3. **Lifetime value** — a **derived view** over `orders` (not a stored column).
4. **Load mode** — **full reload** of `orders` + `order_lines` from the CSVs (deduped). `customers` are
   **upserted** (widely FK'd — never deleted).

## Column mapping — Sales CSV (15 cols, positional; Backup has blank header labels)

| # | CSV column | Target |
|---|---|---|
| 0 | SALES ID | `orders.sales_id` (+ `order_lines.sales_id`) |
| 2 | ORDER DATE | `orders.order_date` |
| 3 | CUSTOMER (name + `(id)`) | `orders.customer_ref` (raw); parsed `(id)` → `orders.customer_id` |
| 4 | ITEM CODE | `📦 Total items N` → header (skip as a line); else `order_lines.item_code` (resolve vs catalogue, unmatched → `item_code_raw`) |
| 5 | QTY | `order_lines.qty` |
| 6 | ITEM LINK | `order_lines.item_link` |
| 7 | NOTES | `orders.order_note` |
| 8 | STATUS | `orders.status` (map below) + drives cuts |
| 9 | SALES TOTAL | `orders.sales_total_idr` (from the header / first row) |
| 10 | PAYMENT BY | `orders.payment_method` |
| 11 | PAYMENT STATUS | `orders.payment_status` (Paid/Unpaid/Partial/Cancel; **Deposit→Partial**) |
| 12 | ADDRESS | `customer_addresses` / order address |
| 13 | COURIER & TRACKING | `order_lines.courier` / `courier_tracking` |
| 14 | FULFILL DATE | basis for `fulfilled_at` / `shipped_at` |

**Normalization:** group rows by `sales_id`. Order-level fields come from the header row (the `📦` row
for new orders, the first row for old). `order_lines` = the non-`📦` rows (old orders: all rows).

### STATUS → enum + stock cuts

| CSV status | `orders.status` | `fulfilled_at` | `shipped_at` | `is_cancelled` |
|---|---|---|---|---|
| Complete | Complete | FULFILL DATE / order_date | same | — |
| Need send | Need send | FULFILL DATE / order_date | NULL | — |
| Need payment | Need payment | NULL | NULL | — |
| Cancel | Cancelled | NULL | NULL | true |
| `0 Day left` | Need payment | NULL | NULL | — | *(assumption: payment countdown — confirm)* |
| `#NUM!` / blank | skip / needs-review (≤2 rows) | — | — | — |

## Column mapping — Customer CSV (8 cols)

| # | CSV column | Target |
|---|---|---|
| 0 | CUSTOMER ID (name + `(id)`) | parse `(id)` → `customers.customer_id`; name → `customers.name` |
| 1 | PHONE | `customers.phone` (normalized 62…) + `phone_raw` |
| 2 | CHANNEL | `customers.channel` |
| 3 | RECIPIENT ADDRESS (multiline) | `customer_addresses.raw_address` |
| 4 | ADDRESS ID | `customer_addresses` label |
| 5–7 | LIFETIME SPEND | **ignore** (empty; derived via the view) |

## Next-round build list

1. **Migration `0037_customer_lifetime.sql`** (drafted alongside this doc, review-only) — the derived
   LTV view. Apply before/with the load.
2. **`reconcile_customers.py`** — upsert `customers` (+ `customer_addresses`) from the Customer CSV.
   Run FIRST (orders FK customers).
3. **`reconcile_sales.py`** — full-reload `orders` + `order_lines` from both sales CSVs (deduped),
   resolving item_codes (paged past the 1000-row cap), mapping status → enum + cuts, linking customers
   by parsed id. Delete order children first (`order_lines`, then `orders`) to respect FKs.
4. **Stock check** — after loading, `available` should drop to realistic levels (11 years of sales now
   deplete). Run the verification SQL (stock identity, negatives) to confirm.

## Caveats

- **Full reload of orders** replaces app-created orders (preorders/test) — fine since the export is
  live, but note it.
- Stock is only correct once **both** inbound (PR67 script) **and** sales are loaded — until then
  `available` is overstated.
