# Jigzle Phase-1 Data Lift — Import Reference

**Date:** 2026-06-16 · **Status:** STEP 1 (mapping spec) — for review before the importer is built.
**Target schema:** migrations `0003`–`0009` (23 tables + `stock_check` view).
**Source:** the `.xlsx` exports in `migration/` and `migration/SheetDev/`.

This document is the column-by-column mapping + transform for every source → target. All
numbers below are **actual counts** read from the source files (not the capped estimates in the
earlier profiling pass). The importer (STEP 2) implements exactly this.

---

## 0. Headline counts & load order

Load in this order (FK dependencies):

| # | Target table(s) | Primary source | Source rows | → Target rows (est.) |
|---|---|---|---|---|
| 1 | `brands` | `brand_country_props` (Order) ∪ catalogue `SELF CODE` | 201 + derived | ~200–230 |
| 2 | `catalogue` | 4 × `Catalog` tabs | 47,457 | **47,454** (−3 dups) |
| 3 | `barcodes` | `Catalog!ARTICLE NUMBER` | 27,105 SKUs | **27,163** (96 collisions reported) |
| 4 | `sku_sources` | `Catalog!SOURCE 0..6` | — | **72,169** |
| 5 | `customers` | Sales `Customer Data` | 7,749 | ~6,900 (dedup by phone) |
| 6 | `customer_addresses` | Sales `Customer Data` | 7,749 | ~7,400 (rows w/ a real ADDRESS ID) |
| 7 | `suppliers` | `OutBuild` (Order) ∪ `Order Data` | 17 + 21 | ~25 |
| 8 | `forwarders` | `OutBuild` + ship_id prefixes | — | ~18 |
| 9 | `shipments` | `Data Shipment` (Warehouse) | 586 | ~586 |
| 10 | `orders` | `Sales Data` + `Backup Sales` | 3,859 + 13,621 | **17,480** |
| 11 | `order_lines` | `Sales Data` + `Backup Sales` | 8,431 + 25,479 | **33,910** |
| 12 | `payments` | `Sales Data` + `Backup Sales` (header/NOTES) | — | ≥17,480 (report exact) |
| 13 | `holds` | Sales `Hold Data` | 17 | ~17 |
| 14 | `inbound` | `Inbound Data` | 13,126 | ~13,126 |
| 15 | `purchase_orders` | `Order Data` | 3,822 | ~3,822 |
| 16 | `missing_pieces` | `Missing Piece Data` | 65 | 65 |
| 17 | `outbound_shipments` | `OutboundData` | 5,712 | ~5,712 |
| 18 | `royalty_paid` | Sales `Royalty Data` | 365 | 365 |

`price_groups`, `pricing_config` (seeded singleton), `loyalty_exclusions`, `royalty_rates`,
`boxes` get **no data this session** (authored / forward-looking / phase-2).

---

## 1. Global transform rules

Applied everywhere unless a table overrides them.

- **`item_code` resolution.** Child rows (`order_lines`, `inbound`, `purchase_orders`,
  `outbound_shipments`, `royalty_paid`, `holds`, `missing_pieces`) reference `catalogue.item_code`
  as a **nullable** FK. On import: trim the cell; if it exactly matches a `catalogue.item_code`,
  set `item_code`; otherwise leave `item_code` NULL, store the original in `item_code_raw` (where
  the table has it), and **count it as "unmatched"** in the report. Never crash, never invent a SKU.
  Free-text / sentinel codes (`📦 Total items N`, `TEMP…`, `Bonus`, `FRAME`, supplier strings) all
  fall through to unmatched.
- **Dates.** All source dates are dot-strings. `yyyy.mm.dd` → `date`. `yyyy.mm` → first of month
  (`yyyy.mm.01`). `Up to 2023` → `2023-12-31` **and** set `is_opening_balance = true` (inbound only).
  Empty / `—` / `X` / `#…` / unparseable → NULL (keep the raw string where a `*_raw` column exists).
- **Money → full IDR `bigint`.** Sales/orders/payments money is in **'000 IDR** → **×1000**
  (e.g. `1590.0` → `1590000`). **`royalty_paid.royalty_idr` is already full IDR — do NOT ×1000.**
- **Phone normalization** (customers): strip non-digits; drop a leading `0` and prefix `62`
  (`081200000000` → `6281200000000`); a bare `8…` → `628…`; an existing `62…` is kept. Store in
  `phone`; keep the original in `phone_raw`. This is the **country-code form** per scope §5 (note:
  it differs from the descriptive comment in `0004`, which is harmless — column is free `text`).
- **Multi-line courier cell** (`COURIER & TRACKING`): line 1 → `courier`, line 2 (if present, ~24%)
  → `courier_tracking`; strip a leading `#`.
- **Idempotency.** Natural-key tables upsert via `ON CONFLICT`. Surrogate-key tables without a
  natural key need a strategy — see **§4 Decision D7**.
- **Dead source sheets** (all `#REF!`/`#N/A`/`#VALUE!` in the export, **do not read**):
  `JIGZLE Catalogue_ Brand, Country, Barcode, Tags.xlsx` (all tabs), `JIGZLE Catalogue_ Barcode.xlsx`,
  the `Sales`/`OutSheet`/`OutRoyalty` tabs of `JIGZLE Props_ Sales.xlsx`, `Stock Check`, `Pricelist`.

---

## 2. Per-table mappings

### 2.1 `brands`
**Source:** `migration/JIGZLE Order(1).xlsx :: brand_country_props` (201 rows; the header row *is*
data — no header). Columns by position: `[0]` brand_code · `[1]` brand_name · `[2]` country ·
`[3]` flag. Enrichment: East Asia `Brands` tab (priority / cadence / new-products URL).

| target | source | transform |
|---|---|---|
| `prefix` | `[0]` brand_code | trim; strip trailing `-` |
| `name` | `[1]` brand_name | as-is (nullable) |
| `country` | `[2]` country | as-is; normalize `Hongkong`→`Hong Kong` (nullable) |
| `priority` / `check_cadence` / `new_products_url` | EA `Brands` tab | fill-down banner rows; East-Asia brands only (nullable) |

**Completeness:** also insert a `brands` row for every distinct `SELF CODE` in the 4 catalogues
that is **not** in `brand_country_props` (name/country NULL) so `catalogue.brand_prefix` FK never
fails. Idempotency key: `prefix`.

### 2.2 `catalogue`
**Source:** `migration/JIGZLE Catalogue — {Japan|East Asia|Americas, UK & Europe|Rest of the World}.xlsx
:: Catalog`. Japan = 37 cols (adds `THEME`,`LOCATION`); others = 35. Counts: 20,969 / 12,229 /
13,498 / 761 = **47,457 rows, 47,454 distinct**.

| target | source col | transform |
|---|---|---|
| `item_code` | `[0] ITEM CODE` | trim (PK) |
| `self_code` | `[1] SELF CODE` | trim |
| `brand_prefix` | `[1] SELF CODE` | FK → `brands.prefix` (explicit col, **not** parsed from item_code) |
| `region` | — derived | bucket of `brands.country` (see **Decision D3**) |
| `original_name` | `[10] ORIGINAL NAME` | UTF-8; `''` ≠ NULL |
| `translate_name` | `[11] TRANSLATE NAME` | |
| `product_type` | `[12]` | free text (scrub `JIgsaw Puzzle`→`Jigsaw Puzzle`, `#VALUE!`→NULL) |
| `sub_type` | `[13]` | free text |
| `piece_count` | `[14] PIECE COUNT` | raw text |
| `piece_count_n` | `[14]` | parse leading integer when unambiguous (NULL for multipack lists) |
| `piece_type` | `[15]` | trim trailing tabs; `Blindbox`→`Blind Box` |
| `size_p/l/t` | `[16/17/18]` | numeric |
| `piece_size` | `[20]` | scrub `Loading ...`/`#VALUE!`/trailing tabs → NULL |
| `image_type` | `[21]` | `#N/A`→NULL |
| `material` | `[22]` | trim trailing tabs |
| `effect` | `[23]` | free text |
| `artist` | `[24] ARTIST` | as-is (royalty partner or free text) |
| `tags` | `[25] TAGS` | comma string |
| `dim_p/l/t` | `[26/27/28]` | numeric |
| `real_weight` | `[29] REAL W` | numeric |
| `article_number` | `[32] ARTICLE NUMBER` | strip `◼️` marker; store the cleaned digits (barcodes split to `barcodes`) |
| `description` | `[33]` | |
| `release_date` | `[34] RELEASE DATE` | raw text |
| `release_year` / `release_month` | `[34]` | parse `yyyy.mm` |
| `theme` / `location` | `[35]/[36]` | Japan only; NULL elsewhere |
| `has_image` | `[9] 🖼️` | `true` if cell == `🖼️`, else `false` |
| `image` | — | NULL (image URLs not in this export → pictures phase) |
| **dropped (derived)** | `[19] SIZE ALL`, `[30] VOL W`, `[31] DIM ALL` | not stored (computed downstream) |

**Dedup (exactly 3 codes, each ×2):**
- `PRE-PM1000-001` — Japan + Americas (cross-file). Keep one row (**Decision D2**).
- `TEN-D-500-821` — Japan ×2 (intra-file). Keep the more complete row.
- `REN-R-300-1285` — East Asia ×2 (intra-file). Keep the more complete row.

"More complete" = fewer NULLs across the mapped columns; ties → first occurrence. Idempotency key:
`item_code`.

### 2.3 `barcodes`
**Source:** `Catalog!ARTICLE NUMBER` (col 32) across all 4 files. **27,105 SKUs** carry ≥1 barcode;
**189** cells hold multiple barcodes; **27,163 distinct** barcodes; **27,294** total tokens.

Transform: split the cell on `,`; for each token strip the `◼️` (U+25FC + optional variation
selector) marker and spaces; keep tokens matching `\d{8,14}` (EAN/UPC/JAN). One `barcodes` row per
token.

| target | value |
|---|---|
| `barcode` | cleaned digit string (TEXT, leading zeros preserved) — PK |
| `item_code` | the SKU's `ITEM CODE` |
| `is_verified` | `true` if the token had the `◼️` marker |

**Collisions: 96** barcodes map to >1 SKU (e.g. `4959295043581` → `APP-300-358` & `ENS-300-358`,
cross-brand rebrands). Rule per brief: **keep the first**, log the rest to the report (`barcode,
kept_item_code, rejected_item_code`). Never crash. Idempotency key: `barcode`.

### 2.4 `sku_sources`
**Source:** `Catalog!SOURCE 0..6` (cols 2–8), unpivoted. **39,534 SKUs** have ≥1 source; **72,169**
URL rows total.

| target | value |
|---|---|
| `item_code` | the SKU |
| `source_index` | 0–6 (the SOURCE column number) |
| `url` | the cell — **only if it starts with `http`** (non-URL cells dropped); trim trailing tabs |

Idempotency key: `(item_code, source_index)`.

### 2.5 `customers` + `customer_addresses`
**Source:** `migration/JIGZLE Sales.xlsx :: Customer Data` — 8 cols, **7,749 rows**:
`[0] CUSTOMER ID` (`Name (NNNN)`) · `[1] CUSTOMER PHONE NUMBER` · `[2] CHANNEL` ·
`[3] RECIPIENT ADDRESS` (multi-line blob) · `[4] ADDRESS ID` (`Name — street…` slug) ·
`[5–7] LIFETIME SPEND` (all empty — ignore). One row ≈ one (customer, address); a customer with
several addresses appears on several rows (≥275 phones have >1 address).

**`customers`** (group rows into one customer):

| target | source | transform |
|---|---|---|
| `phone` | `[1]` | normalize (§1); the dedup key |
| `phone_raw` | `[1]` | original |
| `name` | `[0]` | parse the name out of `Name (NNNN)` |
| `channel` | `[2]` | canonicalize (WA→WHATSAPP, TPED→TOKOPEDIA, …) |
| `channel_raw` | `[2]` | original |
| `ig_handle` | `[2]` | extract handle from `DM IG (handle)` |

Dedup: group by normalized `phone`; for the ~14% with no phone, group by the exact `CUSTOMER ID`
label. Compound labels (`A / B (5520) / C (0351)`) → kept as one customer with the raw label by
default (**Decision D6**).

**`customer_addresses`** (one per source row with a real ADDRESS ID):

| target | source | transform |
|---|---|---|
| `customer_id` | `[1]`/`[0]` | FK to the row's customer |
| `address_label` | `[4] ADDRESS ID` | the slug (import join key for orders); skip rows where it's `#N/A` |
| `raw_address` | `[3] RECIPIENT ADDRESS` | original blob |
| `recipient_name` | `[3]` line 1 | parse |
| `contact_phone` | `[3]` last line | parse (mixed formats) |
| `street/kelurahan/kecamatan/kota/provinsi/kode_pos` | `[3]` | best-effort parse (nullable) |
| `negara` | — | default `Indonesia` |

Idempotency keys: customers — `phone` (or label); addresses — `(customer_id, address_label)`.

### 2.6 `orders` + `order_lines` + `payments`
**Sources (identical column shape, unioned):**
- `migration/JIGZLE Sales.xlsx :: Sales Data` — active, 3,859 orders / 8,431 lines.
- `…/~ Props/JIGZLE Props_ Sales.xlsx :: Backup Sales` — archive 2015–2023, 13,621 orders / 25,479 lines.
- **Zero key overlap** between them (sales_ids and line_ids disjoint) → clean union: **17,480 orders,
  33,910 lines**, all line_ids globally unique.

Columns: `[0] SALES ID · [1] ENCRYPT · [2] ORDER DATE · [3] CUSTOMER ID · [4] ITEM CODE · [5] QTY ·
[6] ITEM LINK · [7] NOTES · [8] STATUS · [9] SALES TOTAL · [10] PAYMENT BY · [11] PAYMENT STATUS ·
[12] ADDRESS · [13] COURIER & TRACKING · [14] FULFILL DATE`.

**Row classification** (drives the split — handles both shapes):
- **Header row:** `ITEM CODE` starts with `📦` (equivalently `SALES ID == ENCRYPT`) → an `orders`
  row only. Active data: every order has one. Backup: only 80 do.
- **Line row:** real `ITEM CODE` → an `order_lines` row.
- **Headerless single-row order** (Backup only, **13,541** of them): a line row whose `SALES ID`
  has no header in the group → it is **both** — synthesize the `orders` row from its order-level
  columns **and** emit the `order_lines` row. (**Decision D5**.)

**`orders`** (from header row, or the order-level fields of a headerless row):

| target | source | transform |
|---|---|---|
| `sales_id` | `[0]` | PK |
| `order_date` | `[2]` | date |
| `customer_id` | `[3]` | resolve `Name (NNNN)` → `customers` (fuzzy; NULL if unresolved) |
| `customer_ref` | `[3]` | raw label kept |
| `address_id` | `[12]` | match `ADDRESS` slug → `customer_addresses.address_label` (NULL if unresolved) |
| `status` | `[8]` | `Cancel`→`Cancelled`; drop `#NUM!`/countdown values |
| `sales_total_idr` | `[9]` | ×1000 → bigint |
| `payment_method` | `[10]` | as-is |
| `payment_status` | `[11]` | `Paid`/`Unpaid`/`Cancel` |
| `order_note` | `[7]` | as-is |

**`order_lines`** (from line rows):

| target | source | transform |
|---|---|---|
| `line_id` | `[1] ENCRYPT` | PK (opaque; never parsed) |
| `sales_id` | `[0]` | FK |
| `item_code` / `item_code_raw` | `[4]` | resolve (§1) |
| `qty` | `[5]` | int (`1.0`→1) |
| `item_link` | `[6]` | |
| `line_note` | `[7]` | |
| `courier` / `courier_tracking` | `[13]` | split multi-line cell |
| `fulfilled_at` | `[14] FULFILL DATE` | date→timestamp |
| `shipped_at` | `[14]` + `[8]` | set from FULFILL DATE when the line/order is `Complete`; else NULL (see **Decision D8**) |
| `is_cancelled` | `[8]`/order status | `true` when order status = `Cancelled` |
| `address_id` | `[12]` | resolve like orders |

**`payments`** (one+ per order, from the header/single row + NOTES):

| target | source | transform |
|---|---|---|
| `sales_id` | `[0]` | FK |
| `amount_idr` | `[9]` | ×1000 |
| `method` | `[10]` | |
| `type` | `[7] NOTES` prefix | `Full`/`No DP`→`Full`, `DP …`→`DP`, `Lunas`→`Settlement` |
| `paid_date` | `[7]`/`[2]` | embedded `dd/mm` in NOTES, else order_date |
| `note` | `[7]` | |

Multiline installment NOTES (`DP 640 BCA\nDP 3020 BCA 12/01\nLunas BCA 01/04`) → **one payment row
per line**. Orders with no payment info → a single `Unpaid` row (or none — **Decision D9**).
Idempotency: orders/lines by PK; payments — see **D7**.

### 2.7 `holds`
**Source:** `Sales :: Hold Data` (header row 2) — `[0] CREATE AT · [1] ITEM CODE · [2] QTY ·
[3] ADDITIONAL NOTES`. 40 nonempty rows, **~17 real holds** (rest are blank spacers).

| target | source | transform |
|---|---|---|
| `created_at` | `[0]` | date→timestamp |
| `item_code`/`item_code_raw`? | `[1]` | resolve (no `item_code_raw` col → unmatched ⇒ skip + report) |
| `qty` | `[2]` | int (CHECK ≥0) |
| `note` | `[3]` | |
| `customer_id` | `[3]` | parse `For: <name>` → customers (NULL if `For: ?`/absent) |
| `released_at` | — | NULL (all treated active) |

Skip blank-spacer rows. Idempotency: **D7**.

### 2.8 `inbound`
**Source:** `migration/JIGZLE Inbound.xlsx :: Inbound Data` (**header row 2**) — `[0] Item Code ·
[1] Qty · [2] Ship ID · [3] Receive Date · [4] NOMOR RESI || DETAIL PRODUK · [5] Dimension / Weight ·
[6] 📌Label · [7] Box ID · [8] Receive Date(dup)`. **13,126 rows.** (Legacy Warehouse `Inbound` is
**not** loaded — it overlaps this and the "Transfer Details" block is dropped per scope.)

| target | source | transform |
|---|---|---|
| `item_code`/`item_code_raw` | `[0]` | resolve (§1); sentinels (`TEMP`,`Bonus`,`FRAME`) → unmatched |
| `qty` | `[1]` | int, **signed** (negatives = stock adjustments) |
| `ship_id` | `[2]` | raw text, nullable (`SUB 191`, `📦2606009`, …) |
| `receive_date` | `[3]` | `yyyy.mm`→`.01`; `Up to 2023`→`2023-12-31`; empty→NULL |
| `receive_date_raw` | `[3]` | original |
| `is_opening_balance` | `[3]` | `true` when `Up to 2023` |
| `tracking` | `[4]` left of `\|\|` | split; multi-tracking joined on ` / ` |
| `receive_note` | `[4]` right of `\|\|` | detail/exclude/adjust reason |
| `excluded` | `[6]` + `[4]` | `true` if `📌Label = Exclude` **or** note matches exclude/gift/rusak |
| `label` | `[6] 📌Label` | `Exclude`/`Hold`/`Tokopedia` (CHECK) |
| `dimension_weight` | `[5]` | raw `L x W x H cm / NNNg` |
| `transfer_box_id` | `[7] Box ID` | TP00N |
| `legacy_ref` | — | NULL (not loading the legacy serial tab) |

Idempotency: **D7** (surrogate `inbound_id`, no native key).

### 2.9 `suppliers` + `forwarders` + `shipments`
**`suppliers`** — from `Order(1) :: OutBuild` (`[0] COUNTRY · [1] FLAG · [2] SUPPLIER`, 17 rows) ∪
distinct `Order Data[1] ACCOUNT / SUPPLIER` (21):

| target | source | transform |
|---|---|---|
| `name` | `SUPPLIER` / `ACCOUNT/SUPPLIER` (after flag) | strip leading flag emoji; UNIQUE |
| `country` | `COUNTRY` / flag | from flag (🇨🇳→China, 🇯🇵→Japan, 🇹🇼→Taiwan, 🌎→Worldwide) |
| `flag` | `FLAG` | emoji kept |
| `type` | inferred | phone-number name→`Taobao account`; nickname→`agent`; `Amazon`→`marketplace`; `Other`→`other` (**Decision D4**) |

**`forwarders`** — `OutBuild[4] FORWARDER` (e.g. `🇨🇳 CBL Air GZ`, `东联`, `Chloe`) + ship_id prefixes
from `Order Data[12] SHIP ID` and `Data Shipment` (`SUB`,`PRI`,`LGB`,`IMA`,`MTE`,`CBL`,`GTS`,`EMS`,…):

| target | value |
|---|---|
| `prefix` | the ship_id prefix (PK) |
| `name` | forwarder name from OutBuild where known (hand-curated) |
| `country` | from origin / known forwarder |

**`shipments`** — `migration/JIGZLE _ Warehouse.xlsx :: Data Shipment` (**header row 3**), **left
block only** (cols 6–12; the middle/legacy blocks 14–18 are mirrors). 586 keyed rows.

| target | source | transform |
|---|---|---|
| `ship_id` | `[7] Shipment ID` | PK |
| `ship_date` | `[6] Date Shipment` | date |
| `origin_country` | `[8] Origin` | strip flag; `HongKong`→`Hong Kong` |
| `tracking` | `[9] Tracking` | |
| `note` | `[10] Notes / Suborder #` | |
| `contents` | `[11] JSON` | parse `[{qty,item}]` → jsonb |
| `received_date` | `[12] Received` | date |
| `forwarder_prefix` | `[7]` | prefix → `forwarders` |
| `status` | derived | `completed` if `received_date` present else `open` |

### 2.10 `purchase_orders`
**Source:** `Order(1) :: Order Data` (22 cols), **3,822 keyed rows**. The `Encrypt` (`[0]`) fans out
to multiple item lines → surrogate `po_id`.

| target | source | transform |
|---|---|---|
| `encrypt` | `[0]` | the `…┆…` key kept as a column |
| `supplier_id` | `[1] ACCOUNT / SUPPLIER` | → `suppliers` |
| `input_date` | `[2] INPUT DATE` | date |
| `item_code`/`item_code_raw` | `[3]` | resolve (§1) |
| `qty` | `[4]` | int |
| `status` | `[5]` | `Processing`/`On the way`/`With Forwarder` (CHECK also allows `Received`) |
| `status_since` | `[5]` | parse `Since {date}` if present |
| `item_cost` | `[6] ITEM COST` | numeric (supplier currency) |
| `item_note` | `[11] ITEM NOTES` | |
| `method` | `[9] METHOD` | EMS/ZTO/SF/… |
| `tracking_to_wh` | `[10]` | |
| `ship_id` | `[12] SHIP ID` | raw text (`—`→NULL) |
| `marketplace_order_id` | `[13] TAOBAO ORDER ID` | **TEXT** (19-digit overflow) |
| `tracking_to_forwarder` | `[14]` | |
| `tracking_to_jigzle` | `[15]` | |
| `shipment_note` | `[16] SHIPMENT NOTES` | |
| `receive_date` | `[20] JIGZLE` | the real receive date leaked here (cols 18–21 are a misaligned block — `[21] RECEIVE DATE` is all `—`; **Decision D10**) |
| `customs_value_usd` | — | not in Order Data (lives in `Order Manage`, ~13 rows — load optionally) |

Idempotency: **D7** (natural key `(encrypt, item_code)`).

### 2.11 `missing_pieces`
**Source:** `Order(1) :: Missing Piece Data` — **65 rows**, clean 1:1.

| target | source |
|---|---|
| `encrypt` | `[0] ENCRYPT` |
| `report_date` | `[1] INPUT DATE` |
| `customer_id`/`customer_ref` | `[2] CUSTOMER ID` (resolve `Name (id)`) |
| `origin_flag` | `[3]` |
| `item_code`/`item_code_raw` | `[4] ITEM CODE` |
| `card_details` | `[5]` |
| `piece_1/2/3` | `[6/7/8]` (`x / y` text) |
| `pic_card_url`/`pic_puzzle_url` | `[9]/[10]` |
| `ship_id` | `[11]` |
| `received_date`/`sent_date` | `[12]/[13]` (`—`/`X`→NULL) |

Idempotency: `encrypt` (unique).

### 2.12 `outbound_shipments`
**Source:** `migration/JIGZLE Outbound.xlsx :: OutboundData` — **5,712 rows**, one SKU per row
(verified: blank-`Customer ID` rows are not continuation rows — each has its own Name/Date/Item Name).

| target | source | transform |
|---|---|---|
| `customer_ref` | `[0] Customer ID` | raw `Name (NNNN)`; when blank use `[2] Name` |
| `customer_id` | `[0]`/`[2]` | resolve → customers (fuzzy; NULL ok) |
| `ship_date` | `[1] Date` | date |
| `recipient_name` | `[2] Name` | |
| `item_code`/`item_code_raw` | `[3] Item Name` field 1 | split on **U+3000** (ideographic space); field 0 = qty, field 1 = code |
| `qty` | `[3]` field 0 | int |
| `address` | `[4] Address` | |
| `courier` | `[5] Courier` | dirty free text (no CHECK) |
| `weight_gram` | `[7] Weight (gram)` | numeric |
| `processed` | `[8]` | bool (`True`/`False`; meaning TBC) |

No link to Sales (reverse-match is phase 2). Idempotency: **D7**.

### 2.13 `royalty_paid`
**Source:** `Sales :: Royalty Data` — **365 rows**, clean 1:1.

| target | source | transform |
|---|---|---|
| `line_id` | `[0] ENCRYPT` | unique |
| `fulfill_date` | `[1] FULFILL DATE` | date |
| `item_code`/raw | `[2] ITEM CODE` | resolve (all `CLO-…`) |
| `qty` | `[3]` | int |
| `royalty_idr` | `[4] ROYALTY (IDR)` | **full IDR — no ×1000** |
| `paid_date` | `[5] PAID DATE` | date; year-only (`2024.0`) → NULL + `paid_date_raw` |
| `partner` | — | default `Voila Arts` (all CLO-) |

Idempotency: `line_id`.

---

## 3. Reconciliation report (every run prints)

Per table: **rows read · inserted · updated · skipped(blank) · unmatched item_code · errors**. Plus:
catalogue **3 dup merges**; barcode **96 collisions** (kept/rejected); customers **dedup merges**
(rows→customers); sales **headerless-order synthesises**; per-source **rows-read vs target-rows**
vs the §0 targets above. `--dry-run` computes all of this and writes **nothing**.

---

## 4. Decisions / ambiguities — need your call before STEP 2

- **D1 — Barcode source.** The component file you named (`…Brand, Country, Barcode, Tags.xlsx`) is a
  **dead formula export** (all `#REF!`). I'm using `Catalog!ARTICLE NUMBER` instead — real data,
  27,105 SKUs. OK? (Or can you re-export that component sheet *with values*?)
- **D2 — `PRE-PM1000-001`.** Cross-region dup (Japan vs Americas). Keep the **more-complete row**
  by default — or do you want a specific region kept? (scope §7 left this open.)
- **D3 — `catalogue.region`.** Derive from `brands.country` bucketed into the 4 enum values:
  `Japan→Japan` · `China/Taiwan/Korea/Hong Kong→East Asia` · `USA/Canada/UK/Europe→Americas`
  (= the "Americas, UK & Europe" book) · `Indonesia/Worldwide/unknown→Rest of World`, falling back
  to the **source workbook** when a brand has no country. Confirm the buckets (esp. where
  Indonesia/Worldwide go), or just use source-workbook region instead?
- **D4 — Supplier `type`.** Inferred (phone-number→Taobao account, nickname→agent, Amazon→marketplace).
  OK to infer, or leave NULL?
- **D5 — Backup headerless orders.** 13,541 single rows become both an `orders` and an `order_lines`
  row. Confirm.
- **D6 — Compound customer labels** (`A / B (5520) / C (0351)`). Default: keep as one customer (raw
  label). Or split into separate customers?
- **D7 — Idempotency for surrogate-PK tables** (`customers` no-phone, `payments`, `holds`, `inbound`,
  `purchase_orders`, `outbound_shipments`, `customer_addresses`). These have no natural unique key in
  the schema. Two options: **(a)** truncate-and-reload those tables each run (simple, fully
  re-runnable, resets ids); **(b)** add deterministic natural-key unique columns in a small `0010`
  migration to enable true `ON CONFLICT` upsert. I recommend **(a)** for the initial lift. Your call.
- **D8 — `shipped_at`.** Source has a single `FULFILL DATE`, no separate ship stamp. Plan: set both
  `fulfilled_at` and `shipped_at` = FULFILL DATE when the order is `Complete`; for `Need send` set
  `fulfilled_at` only. This makes the stock view's reserved/physical split correct for historical
  data. OK?
- **D9 — Orders with no payment info** → emit one `Unpaid` payment row, or none?
- **D10 — Order Data receive date.** Cols 18–21 are a misaligned block; the real receive date sits in
  `[20] JIGZLE`, and `[21] RECEIVE DATE` is all `—`. I'll read `[20]`. Confirm.

---

*Once you've signed off (or adjusted) the above, STEP 2 builds `scripts/import/` per this spec:
re-runnable, `--dry-run`, service-role connection (`SUPABASE_SERVICE_ROLE_KEY` + the project URL),
printing the reconciliation report.*
