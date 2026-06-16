# Jigzle Phase-1 data lift

Loads the old Google-Sheets `.xlsx` exports in `migration/` into the Supabase Phase-1
schema (migrations `0003`–`0010`). Mapping spec: [`docs/import-reference.md`](../../docs/import-reference.md).

## Prerequisites
- Python 3.9+ with **openpyxl** (`pip install openpyxl`). No other deps — PostgREST
  calls use the stdlib.
- `0010_drop_region.sql` applied to the remote DB (the importer refuses to run real
  loads while `catalogue.region` still exists).
- `.env.local` at the repo root with `NEXT_PUBLIC_SUPABASE_URL` and
  **`SUPABASE_SERVICE_ROLE_KEY`** (service role bypasses RLS for bulk load; the anon
  key is never used).

## Run
```bash
# Dry-run (default, safe): reads xlsx, runs every transform, prints the
# reconciliation report, writes NOTHING. No DB connection needed.
python3 scripts/import/import_jigzle.py

# Real clean load: empties every data table and reloads in FK order.
python3 scripts/import/import_jigzle.py --execute
```

## How it works
- **Full clean load (D7):** every run deletes all data tables (reverse-FK order) and
  reloads them, so surrogate ids stay internally consistent. Idempotent / re-runnable.
- **FK-ordered:** `brands → catalogue → barcodes/sku_sources → customers/addresses →
  suppliers/forwarders/shipments → orders/order_lines/payments → holds → inbound →
  purchase_orders → missing_pieces → outbound_shipments → royalty_paid`.
- **Unmatched `item_code`** never crashes: stored in `item_code_raw`, counted in the report.
- **Barcode collisions** are kept-first and every one is logged (barcode, kept, rejected).

## Files
- `import_jigzle.py` — orchestrator, source readers, per-table loaders, reconciliation report.
- `transforms.py` — pure transform helpers (phone, dates, money, item-code resolution, …).
- `db.py` — minimal PostgREST client + `.env.local` loader.
