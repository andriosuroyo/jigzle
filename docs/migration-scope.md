# JIGZLE Operations — Migration Scope & Build Spec

**Date:** 16 June 2026
**Purpose:** Move Jigzle's operations off the broken Google Sheets system into the existing web app (Next.js + Supabase). This doc is the handoff for the build (Claude Code). It lists every table, the stock engine, each module's workflow, the data lift, and the build order.
**Source of truth:** the verified sheet models in memory + the xlsx files in `Life/jigzle/migration/`.

---

## 1. Why we are doing this

The old system is a web of Google Sheets tied together by `IMPORTRANGE` links and Apps Script. Most of those links are now dead (14+ source sheets gone, plus the `11Ks5` sheet that broke Outbound). The **data is safe** inside the sheets; the **plumbing is rotten**.

So we do not rebuild the link web. We lift the surviving data into a database, rebuild the logic as code, and drop the sheet plumbing for good.

**Design principles**

- One source of truth per concept. No copies.
- Compute, don't store stale. Stock, prices, loyalty status are calculated live.
- Separate the roles: Sales, Purchasing, Warehouse, Admin each see their own view.
- Keep the workflow people already know; only fix what is broken or manual.

---

## 2. The data model

These are the core tables. Types are a guide; the build can refine them.

### Catalogue (the spine)

Every other table points at `item_code`. ~47,455 SKUs, globally unique (only 1 dup to fix on import).

**`catalogue`**
- `item_code` (PK) — brand prefix + model, e.g. `TEN-DS-1000-764`
- `self_code`, `original_name`, `translate_name`, `description`
- `product_type`, `sub_type`, `piece_count`, `piece_type`
- `size_p`, `size_l`, `size_t`, `piece_size` (puzzle size)
- `dim_p`, `dim_l`, `dim_t`, `real_weight`, `vol_weight` (box / shipping; `vol_weight = dim_p×dim_l×dim_t ÷ 6000`)
- `material`, `effect`, `image_type`, `tags`, `image`
- `artist` — royalty partner (Mentol Art / Voila Arts) or blank
- `article_number`, `release_date`
- `brand_id` (FK → brands)
- Derived in app, not stored: `size_all`, `dim_all`, `vol_weight`.

**`brands`** — `brand_id` (PK), `prefix` (e.g. TEN, RAV, SUNT), `name`, `country`. Region/origin comes from here, not a separate column.

**`barcodes`** — `barcode` (PK, unique), `item_code` (FK). One SKU can have many barcodes; each barcode points to exactly one SKU. On a reused barcode, block save and force a suffix (e.g. `0123456789A`).

**`sku_sources`** — `item_code` (FK), `url`. Multiple source URLs per SKU (the old Source 0–6). URLs only.

### Customers

**`customers`** — `customer_id` (PK), `name`, `phone` (normalized, unique — see §5), `channel`, `lifetime_spend` (computed), `loyalty_tier` (computed), `to_next_tier` (computed). Phone is the dedup key.

**`customer_addresses`** — `address_id` (PK), `customer_id` (FK), `recipient_address`. One customer → many addresses.

### Sales

**`orders`** — `sales_id` (PK), `customer_id` (FK), `order_date`, `status` (Need payment / Need send / Complete / Cancelled), `sales_total` ('000 IDR), `payment_by`, `payment_status`, `address_id` (FK), `courier_tracking`, `fulfilled_at`, `shipped_at`.

**`order_lines`** — `line_id` (PK, = the old "Encrypt"), `sales_id` (FK), `item_code` (FK), `qty`, `line_status`, `item_link`, `notes`. (This replaces the interleaved 📦-header + line rows in the old Sales Data.)

**`payments`** — `payment_id` (PK), `sales_id` (FK), `amount`, `type` (DP / full), `paid_date`, `method`. One order → many payments (DP then settlement). Drives lifetime spend.

**`holds`** — `hold_id` (PK), `item_code` (FK), `qty`, `customer_id` (FK, optional), `created_at`, `notes`. A physical hold-rack reservation. Auto-released when the held item is fulfilled. Reduces available stock.

### Procurement

**`purchase_orders`** — `po_line_id` (PK, = Encrypt), `supplier_id` (FK), `item_code` (FK), `qty`, `status` (Processing / On the way / With Forwarder / Received), `item_cost`, `method`, `ship_id` (FK), `customs_value_usd`, `tracking_to_wh`, `tracking_to_forwarder`, `tracking_to_jigzle`, `input_date`, `receive_date`, `customer_id` (FK, optional — link an item to the customer who wants it).

**`suppliers`** — `supplier_id` (PK), `name`, `country`, `type` (Taobao account / agent), `flag`.

**`forwarders`** — `forwarder_id` (PK), `name` (CBL, MTE…), `country`.

**`shipments`** — `ship_id` (PK, e.g. SUB 191 / IMA 1023), `forwarder_id` (FK), `status` (open / completed), tracking legs, dates. **`ship_id` is the join to Inbound.**

**`missing_pieces`** — `mp_id` (PK), `customer_id` (FK), `item_code` (FK), `card_details`, `piece_1/2/3`, `pic_card`, `pic_puzzle`, `ship_id`, `receive_date`, `sent_date`. Customer-service reorder flow; also talks to suppliers.

### Inventory

**`inbound`** — `inbound_id` (PK), `item_code` (FK), `qty`, `ship_id` (FK, nullable for legacy), `receive_date`, `tracking`, `dimension_weight`, `label`, `excluded` (bool — gift/damaged items net to 0 stock), `is_opening_balance` (bool — the "Up to 2023" rows). The **"+" side of stock**.

### Pricing

**`price_groups`** — `group_id` (PK), `price_group`, `cost_low`, `cost_high`, `coeff`, plus per-status prices (`new`, `props`, `out`, `rare`, `in`). Fine-grained cost bands; higher coeff = higher price.

**`pricing_config`** — global rules: round-up step (50K), psychological add (45K), rare flag, marketplace uplift (7.5%), and which product types / SKUs are loyalty-excluded.

**`outbound_shipments`** (history + billing) — `shipment_id` (PK), `customer_id`, `date`, parsed `item_code` + `qty`, `address`, `courier`, `weight_gram`. Plus a **`boxes`** child for new shipments: `box_id`, `shipment_id` (FK), `real_weight`, `dim_p/l/t`, `bill_by_volume` (bool), `chargeable_weight` (= max(real, vol)). Feeds the monthly TIKI billing check.

**`royalty_paid`** — `id` (PK), `line_id`, `fulfill_date`, `item_code`, `qty`, `royalty_idr`, `paid_date`. Migrate as-is.

**`royalty_rates`** — `partner` (Mentol / Voila) × piece-size columns (35P, 63P, 80P, 120P, 300P, 500P, 1000P, 1200P). **Empty for now; filled in phase 2.**

---

## 3. The stock engine (the centerpiece)

This is what broke and the highest-value rebuild. In Sheets it was heavy (a formula per SKU); in Postgres it is one grouped query that runs instantly. It re-lights the old "Stock Check" screen.

**Two-stage stock cut:** stock is committed at the **Sales Fulfill** step (goods assigned to a customer), but the item physically leaves only at **Outbound** (shipped). So there are two numbers.

Per SKU:

| Number | Formula | Use |
|---|---|---|
| **Available** (sellable) | `Σ inbound(not excluded) − Σ fulfilled − Σ holds` | don't oversell; reorder |
| **Physical on-hand** | `Σ inbound(not excluded) − Σ shipped` | warehouse shelf count |
| **Reserved (Fulfill)** | `Σ fulfilled − Σ shipped` | the picking queue |
| **Pending (on-order)** | `Σ purchase_orders WHERE status='Processing'` | incoming, not shipped |
| **On the way (en-route)** | `Σ purchase_orders WHERE status IN ('On the way','With Forwarder')` | incoming, shipped |
| **Last receive** | `max(inbound.receive_date)` | freshness |

History reaches back to 2015 on both sides: inbound carries an **opening-balance bucket** ("Up to 2023" rows) and sales has the **Backup Sales** archive (2015–2023). So `inbound − sales` is valid across all time. No separate baseline needed.

Build as a SQL view (or materialized view if needed for speed). This view *is* the Stock Check page.

---

## 4. Modules (workflow + key rules)

### Sales
Pipeline: **draft → input → payment → fulfill → data.**
- **Input** is the dedup gate: search customer (by phone), load or create. Show loyalty tier + distance to next tier. Strong **SKU search with pictures** (this unblocks several things below).
- **Payment** handles **DP vs full**. "Arrived" gate: an order can only move to Fulfill when *all* its lines have arrived.
- **Fulfill** cuts stock, assigns address + courier + tracking, and shows live stock (Available / Reserved / Hold).
- **Cancelled orders are kept**, not deleted — they are valuable customer-interaction history.
- **Loyalty:** New 0% · Bronze 2.5% @2M · Silver 5% @4M · Gold 7.5% @6M · Platinum 10% @8M · Diamond 15% (top-N customers, recomputed). Discount excludes low-margin items (per SKU or product type).

### Procurement (Order)
Pipeline: **manual/input → unsorted → manage → data.** Open pipeline only; received lines leave to Inbound (matched by **Ship ID**). Orders grouped **by country**.
- **Sales → Purchasing handoff:** Sales flags a line "needs procurement"; it appears in Purchasing's queue without merging the two views or polluting Sales. (Replaces today's separate Order Manual list.)
- **Supplier bridge (generalize the Watchlist):** overseas suppliers (Brian/Japan, future others) get a two-way, interlinked surface — our request appears for them, their "can order / cannot" flows back, and a rejection auto-cancels our line. No manual mirroring.
- **Step-completion + staleness alerts:** each line moves through Superbuy-registered → consolidated → with forwarder → invoiced. Flag lines stuck or stale at a step (fixes the Superbuy-registration miss).
- **Document generation:** Invoice + Packing List (today's manual "JIGZLE Print") generated from the shipment's lines + customs values. Customs sheet generated too.

### Receiving (Inbound)
Select an arriving shipment → scan each barcode → resolves to SKU (catalogue lookup). Unknown barcode → add to Catalogue first; missing dimensions → warehouse inputs into Catalogue. Cross-check scanned items against what the Order said was coming; report missing/extra. Save appends to `inbound`.

### Outbound / shipping & billing
A "ready to ship" worklist = order lines fulfilled-but-not-shipped. Pick → scan → weigh → mark shipped (stamps `shipped_at`, weight, tracking).
- **Box / volumetric model:** a shipment can split into several **boxes**. Per box: real weight + optional P/L/T. **Chargeable weight = max(real, volumetric)**, volumetric = P×L×T÷6000. Flag "bill by volume" → warehouse measures. Feeds the **monthly TIKI billing check** (with +300 g/kg rounding).

### Catalogue & scrape
One global `catalogue`. Scrape grabs data + prices from set websites and keeps everything. The system flags **SKUs not yet in the catalogue** as an **Admin review queue** (the link is the key field). Admin inputs using the brand-prefix convention; the app guides correct entry to avoid duplicate "new items." Same product on different sites → extra source links on the one SKU. A persistent **Ignore list** stops re-scrapes resurfacing junk.

### Pricing
Computed **live** from the latest scraped base cost:
`price = base_cost × coeff(band) + landed costs` → **round up to nearest 50K** → **+45K** (ends 95K/45K). Skip the +45K for low-cost (glue) and **rare** (rare stays round: 1200K, 1950K). **Marketplace price = website × 1.075.** Make the +45K systematic via a toggle.

### Dashboard
Model it on the old "Dashboard: Manage": catalogue, pricelist, stock, status, market/website price — a live read view.

---

## 5. Data lift (migration transforms)

Source = the xlsx in `Life/jigzle/migration/`. Key transforms:

- **Sales:** split the interleaved 📦-header + line rows into `orders` + `order_lines` (join on Sales ID; Encrypt = line key). Merge **Backup Sales** (25,977 rows, 2015–2023, same shape; older name-based IDs) → ~38k total.
- **Customers:** split into `customers` + `customer_addresses` (one-to-many). Normalize **phone** to country-code, digits-only, no leading 0 (e.g. `081200000000` → `6281200000000`); set as unique key; keep raw input.
- **Inbound:** dates — `yyyy.mm` → `yyyy.mm.01`; `Up to 2023` → `2023.12.31` + `is_opening_balance`; empty → null. `excluded` rows contribute 0 to stock. Drop Transfer Details (legacy Tokopedia warehousing).
- **Outbound:** parse the packed Item Name (`qty　code　name`, always one SKU per row). Migrate as standalone history; reverse-engineer the Sales↔Outbound match in phase 2 (IDs don't share a key).
- **Order:** open pipeline only; current data = history. Ship ID = the Inbound join.
- **Catalogue:** union 4 regions → one table; fix the 1 dup (`PRE-PM1000-001`, recompute Vol W). Pull barcode from the component sheet into `barcodes` (enforce uniqueness). Sources = URLs only.

---

## 6. Build order & phasing

**Phase 1 — the operational core (this migration)**
1. `catalogue` + `brands` + `barcodes` + `sku_sources` (the spine).
2. `price_groups` + `pricing_config` + live pricing (reuse Calculator v1 logic).
3. `customers` + `customer_addresses` (with phone dedup + loyalty).
4. `orders` + `order_lines` + `payments` + `holds` (Sales), incl. Backup Sales lift.
5. `inbound` (Receiving + scan).
6. `purchase_orders` + `suppliers` + `forwarders` + `shipments` (Procurement) + `missing_pieces`.
7. **Stock engine** (the view) → lights up Stock Check.
8. Outbound module + `outbound_shipments` + `boxes` (billing).
9. Basic dashboard.

**Phase 2**
- Customer portal (order history, pending, loyalty, item status).
- Royalty rates filled + royalty calc.
- Reverse-engineer Sales↔Outbound history match.
- Supplier bridges (Watchlist generalized) + Sales→Purchasing flag.
- Document generation (Invoice / Packing List / Customs).

**Phase 3**
- Marketplace sync (Shopee / Tokopedia / Tiktok / Shopify) + channel stock.
- Picture / image pipeline.
- Shopee warehousing (if pursued).

---

## 7. Still to confirm during build

- Which region's `PRE-PM1000-001` to keep.
- Exact extra columns wanted on Order Input (to match Order Data).
- Stock Check "Temp Queue" meaning (likely items mid-scan; low priority).
- Whether the Calculator's source-discount list needs porting (Andrio said no migrate).
- The royalty rate values (phase 2).

---

*Companion references (memory): Sales / Inbound / Outbound / Order / Check verified models, the operational model, the dependency-break record, and the Catalogue + Pricelist model. Source files: `Life/jigzle/migration/` (5 main sheets + full SheetDev).*
