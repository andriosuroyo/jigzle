# Session 2 — Data lift (import) kickoff prompt

Run AFTER the Phase-1 schema (migrations 0003–0009) is committed and applied to Supabase
(`supabase db push`). Paste the block below into Claude Code with `Life/jigzle` open.

---

You are continuing the Jigzle operations migration in this repo. The Phase-1 schema is already
written and applied (migrations 0003–0009: 23 tables + the stock_check view). This session builds
the DATA LIFT — load the real data from the old Google Sheets (exported as .xlsx) into that schema.

READ FIRST:
- docs/migration-scope.md, especially §5 (data-lift transforms) and §2 (the tables).
- supabase/migrations/0003_catalogue.sql … 0009_stock_view.sql — the exact target columns/types.
- docs/adr/002-phase1-operations-schema.md (your own ADR) — decisions like money = bigint full IDR.
- DATA_SOURCES.md.
The source spreadsheets are .xlsx files in migration/ (the 5 main sheets) and migration/SheetDev/
(catalogue per region, Pricelist, and ~ Props/JIGZLE Props_ Sales.xlsx which has the Backup Sales tab).

APPROACH — two steps, approval gate between them:
STEP 1 (first): write docs/import-reference.md — a per-source mapping: for each source sheet/tab,
the column-by-column mapping to the target table(s) and the exact transform. Include row counts and
any ambiguities. Stop and let me review before writing code.
STEP 2 (after I approve): build a re-runnable importer (a script in the repo, e.g. scripts/import/;
Python+openpyxl is fine for reading .xlsx, or Node — your call). It must be:
- idempotent (upsert by primary key; safe to re-run),
- have a --dry-run that loads nothing but prints a reconciliation report,
- print a RECONCILIATION REPORT every run: rows read vs inserted vs skipped, dedup merges, barcode
  collisions, unmatched/parse failures.
It connects to Supabase with the SERVICE-ROLE key (bulk load must bypass RLS — do NOT use the anon
key). Read it from env; tell me exactly which env var you need if it's not present.

THE TRANSFORMS (detail in scope §5; key specifics):
- Catalogue: union the 4 region catalogues into `catalogue`. Region/origin is NOT a column — derive
  it via `brands` (prefix → name → country). 3 duplicate item codes to merge (each appears 2×):
  PRE-PM1000-001 (Americas+Japan — keep one, recompute vol_weight), REN-R-300-1285 (East Asia ×2),
  TEN-D-500-821 (Japan ×2) — for the within-region pairs keep the more complete row. Source 0–6 →
  `sku_sources` (URLs only; ignore non-URL cells). Artist col → royalty tag (Mentol Art / Voila Arts).
  Barcodes come from the catalogue component sheet (Worksheet/CATALOGUE COMPONENTS/JIGZLE Catalogue_
  Brand, Country, Barcode, Tags.xlsx) → `barcodes`: one SKU → many barcodes, each barcode UNIQUE; on
  a reused barcode, keep the first and report the rest (don't crash). Compute vol_weight = P×L×T÷6000.
- Customers (Sales `Customer Data`): split into `customers` + `customer_addresses` (one-to-many).
  Normalize phone to country-code digits, no leading 0 (081… → 6281…); unique; keep the raw value.
- Sales (`Sales: Data`): the rows interleave order-header rows (Item Code = "📦 Total items N") and
  line rows — split into `orders` (one per Sales ID) + `order_lines` (line_id = the "Encrypt" value).
  Money is in '000 → ×1000 to full IDR. DP vs full → `payments` (one order → many). `Hold Data` →
  `holds`. Keep cancelled orders. THEN merge the `Backup Sales` tab (2015–2023, ~25,977 rows, same
  column shape, older name-based IDs) into the same tables.
- Inbound (`Inbound Data`, header on ROW 2): dates — `yyyy.mm` → `yyyy.mm.01`; "Up to 2023" →
  2023-12-31 with is_opening_balance=true; empty → null. `excluded` rows contribute 0 to stock (set
  the flag; don't drop). ship_id nullable. Ignore the legacy Transfer Details columns.
- Outbound (`OutboundData`): Item Name is packed "qty　code　name", always ONE SKU per row → parse
  into qty + item_code. Load as standalone `outbound_shipments` history (do NOT try to link to Sales
  rows — that reverse-match is a later phase). Keep weight (TIKI billing).
- Order (`Order Data`): open pipeline → `purchase_orders`; derive `suppliers`, `forwarders`,
  `shipments` from it + the OutBuild config tab; `Missing Piece Data` → `missing_pieces`. customs USD.

OUT OF SCOPE this session: UI, marketplace, pictures, royalty values (table stays empty), the
Sales↔Outbound reverse-match, and any pricing computation. Just land the data cleanly with a report
I can trust.
