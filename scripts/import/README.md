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

## Post-import cleanup: `reconcile_customers.py`

The original load deduped customers by **phone** but mapped each order's label to a
customer with last-write-wins — so one person who used several numbers split into several
phone-keyed customer rows, while **all** their orders landed on whichever phone-key was
written last. `reconcile_customers.py` repairs this against the source Customer Data CSV
(the authoritative `"<alias> (last4)"` CUSTOMER ID):

- per CUSTOMER ID label it **keeps the record already holding the orders** and absorbs the
  phone-split siblings (re-points orders/holds/shipments/POs/missing-pieces, moves
  addresses de-duped, unions channels, deletes the emptied siblings);
- sets the keeper's name to the alias and orders phones so **#1 is the label's identity
  number** (last-4 = the `(XXXX)` code) — so it displays as the label, e.g. `Henny Y (1299)`;
- a customer with **more than three numbers** keeps the identity + next two and is
  **reported** (the app holds three) for a manual decision;
- **never** deletes an order (sales after the last CSV date are app-entered → left as is)
  or a customer no CSV label claims (new app customers).

```bash
# 1) CSV only — no DB. Verify the model + the >3-number list.
python3 scripts/import/reconcile_customers.py --csv-report \
    --customers Customer_Data.csv --sales Sales_Data.csv --backup Backup_Sales.csv

# 2) Dry-run vs the live DB (read-only) — prints the full plan, writes NOTHING.
python3 scripts/import/reconcile_customers.py  <same --customers/--sales/--backup args>

# 3) Apply (writes via SERVICE-ROLE key in .env.local). Take a DB backup first.
python3 scripts/import/reconcile_customers.py --execute  <same args>

#    Scope a first run to one customer end-to-end:
python3 scripts/import/reconcile_customers.py --execute --label "Henny Y (1299)"  <same args>
```
