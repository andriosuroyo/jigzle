# Jigzle backlog (migrated from `life/BACKLOG.md`, 2026-07)

*Objective: port ops from Google Sheets to the web app. **20% cap** — anything beyond
ordering/supplier management is scope creep.*

> Migrated from the personal `life` repo so Jigzle planning lives with the Jigzle code.
> **Now** = active / near-term; **Later** = parked or future. Fold into `docs/` specs as actioned.

## Now
- **[JZ-001](JZ-001-orders-pipeline.md) — Orders pipeline window** (spec ready to build): consolidate New/Pending/Fulfill/Outbound hub cards into one Orders window with pipeline tabs Pending → Fulfill → Outbound + History.
- **Physical stock count on the floor** — the original migration goal: validate migrated numbers vs reality with Stock Check + apply adjustments. **Practice run on a tiny brand (e.g. 3DC×4) = the go/no-go gate first.**
- **Walk a real order through the new pipeline** — mark a Partial order paid → Need-send → Fulfill → Outbound; **test Return-to-Fulfill**; run `smoke_orders.py`; eyeball one fully-paid + one DP order (validates `create_order` paid_idr seed).
- **Populate `/settings` with real data** — box dimensions for XS/XM/XL/S2/M2/L2 (now filler 1/1/1) + confirm/extend courier speed tiers.
- **Stock Check polish PR** — rename Checkbox/Scan "Close" button → "Save"; scan-guard tweak (resolve 12/13-digit barcode first, only flag "garbled" if check digit fails *and* not_found). App-only, no migration.
- **Mobile UI walkthrough** of remaining screens (Order / Outbound / Fulfill) → note changes.

## Later
- **Cancel/refund:** line-level cancel + refund tail (JZ-SAL-D9 remainder — set `order_lines.is_cancelled`, guard non-shipped, add `AND NOT is_cancelled` to Fulfill/Outbound predicates, refund-money UI). + **Restock alert** (JZ-SAL-A1) — notify when a backordered SKU goes Available.
- **SETTINGS module expansion** — make hardcoded fields user-editable (searchable, keyed e.g. "Sales → Payment → Method"); wire Sales payment-method picker to SETTINGS; per-user SETTINGS override.
- **"preorder OK" availability flag** on the Items search card (3rd line) — blocked on the auto-scrape that would tell us preorder availability.
- **Sales batch-pricing model** — order-level shipping + discount + global price override + per-line list price → Pricelist phase 2.
- **Barcode cleanup** — merge doubled SKUs (`Also: SKU-xxx` pairs + 5 cross-brand collisions; pick canonical `item_code`, repoint ledger, retire dup); decide big-series shared barcodes (CEA-2903 ×14, KAW-KT ×11/12, MEG-50879 ×8) — accept multi-option picker vs distinct barcodes.
- **Outbound import rowcount reconcile** (low priority) — 5,495 loaded vs ~5,712 target (217 / ~3.8% unaccounted); check reconciliation report (likely skipped-blank rows).
- **Stock Check cleanup** — swap standalone `.sc-*` styles to `DataList` (F6 deferred).
- **Rare Finder** — connect Claude-in-Chrome → live availability for TEN-D-1000-336 + EPO-97-001 (Imaginatorium / jigsaw.jp / Epoch); ask Brian for an Imaginatorium catalog feed (best oracle, removes a scraper); resolve `RARE_FINDER_SPEC.md` open questions before building v0 watchlist monitor.
- **Sourcing scraper** — Yahuoku / Mercari / Fromjapan keyword search (picture, name, qty, price; sort cheapest).
- **Glide / Airtable evaluation** — tooling for Jigzle & MindHive ops systems.
- **Jigzle calculator app revamp** — ask Irene what she'd like added.
- **TIKI billing dispute** (Apr–May) — overcharges Lyli +2kg (15 Apr) & Dewi +3kg (7 May); missing-receiver lines (Pierre Hany / Caroline×2 / Ade Winata); Jessi (30 May) shipped-but-unbilled. Reports in `outbound`.
- **Benjamin (Clover blind box)** — send new pictures + follow up 3D box mock-up + specify blind-box content.
- **Suppliers:** John Wang — follow up tables 10 + 4 · Princess (Clover) — pending orders (e.g. X10-122), send sample to Chloe / assess big-puzzle size · Oxihom — puzzle-tray restock · Yoga (MTE) — follow up TZAN0428 / SF5598.
