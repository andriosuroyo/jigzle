# 002 — Phase 1 operations schema: keys, units, and the stock view

**Date:** 2026-06-16
**Status:** Accepted

## Context

Phase 1 of the Jigzle migration moves operations off the broken Google Sheets system
into Supabase. Migrations `0003`–`0009` add the operational core: the catalogue spine,
customers, sales, receiving, procurement, pricing/royalty/outbound, and the stock engine.
The schema was designed against the real source workbooks in `migration/` (profiled
end-to-end), not just the conceptual sketch in `docs/migration-scope.md`. A few source-data
realities forced modeling calls that are not obvious from the DDL alone.

## Decisions

### `item_code` is the global TEXT primary key
Every operational table FKs to `catalogue.item_code`. The raw export is **not** globally
unique (`PRE-PM1000-001` appears in both the Japan and Americas workbooks; plus two
intra-file dups), but those ~4 collisions are dirty data merged at **import**, not a
legitimate "same code, two products" case. A single TEXT PK keeps ~10 FK tables clean;
the alternative (surrogate PK + `UNIQUE(item_code, region)`) would force every child to
resolve by region. `brand_prefix` is taken from the explicit `self_code` column, never by
string-splitting `item_code` (a handful of irregular codes break the prefix convention).

### All money is stored in full IDR (`bigint`)
Source units are inconsistent — Sales totals are in **'000 IDR**, royalty is in **full
IDR**. Everything is stored as full-rupiah `bigint` (Sales values are `×1000` at import).
One consistent unit across `orders`, `payments`, `royalty_paid`, and pricing; IDR has no
sub-unit, and `bigint` holds the largest sums comfortably.

### `ship_id` is a soft, free-text key — no hard FK
`ship_id` is the join between `inbound`/`purchase_orders` and `shipments`, but it is a
legacy free-text key with two intentional shapes:
- forwarder shipments entered into the shipments ledger, e.g. `SUB 191`, `IMA 1023`;
- the **`📦YYMMXXX`** form — 📦 icon + `YYMM` + a 3-digit counter that restarts at `001`
  each month — for inbound items **not** entered into the shipments Data. The 📦 icon
  deliberately distinguishes these ad-hoc ids.

Because many legacy/ad-hoc ids will never exist in `shipments`, `ship_id` stays a nullable
`text` column with **no** enforced FK; joins are opportunistic.

### Stock is a plain SQL view, never a stored number
`stock_check` (`0009`) computes the two-stage cut live: stock is committed at Sales Fulfill
(`order_lines.fulfilled_at`) and physically leaves at Outbound (`order_lines.shipped_at`).
`available + reserved + on_hold = physical` by construction. Built as a plain view with
`security_invoker = true` so base-table RLS applies; partial indexes on the base tables
support the per-SKU aggregations. Switch to a materialized view + refresh only if the
screen is slow at ~47k SKUs (a stored stock number risks overselling).

### Courier / tracking / fulfill / ship live on `order_lines`, not `orders`
The scope doc sketched these on `orders`, but the source data carries them per line, and
the stock engine sums fulfilled/shipped **per `item_code`** — which requires line-level
timestamps. They were moved to `order_lines`.

### CHECK enums only on clean operational statuses
Order/payment/PO/inbound/shipment statuses are clean small domains → `CHECK` constraints
(import normalizes, e.g. source `'Cancel'` → `'Cancelled'`). Catalogue fields
(`product_type`, `sub_type`, `effect`, `material`) and `channel`/`courier` are heavily
polluted (channel = 926 raw variants, courier = 61) → plain `text` with an optional `_raw`
column, normalized in the app/import. No hard enum types anywhere (CHECK is easier to evolve).

## Consequences

- The import step owns the heavy lifting: deduping `item_code`, `×1000` money conversion,
  normalizing phone/channel/courier, splitting the interleaved Sales Data into
  orders/lines, exploding barcodes and sources, and parsing addresses. The schema is shaped
  to receive that cleaned data.
- `brands`, `price_groups`, `forwarders`, `suppliers`, and `royalty_rates` have no faithful
  source and are authored/derived (`royalty_rates` stays empty until phase 2).
- Shipping methods and FX already exist in `0001` (`shipping_methods`, `currencies`) and are
  reused for live pricing — not re-created.
- RLS is a single `for all` policy per table via `is_allowed_user()` (see `docs/001`),
  since the operator both reads and writes ops data.

## How to verify

```sql
-- every table has RLS forced on
select relname from pg_class where relrowsecurity and relnamespace = 'public'::regnamespace;

-- the stock view returns one row per catalogue SKU
select count(*) from public.stock_check;        -- == count(*) from catalogue
select * from public.stock_check where available < 0 limit 20;   -- oversold / data check
```
