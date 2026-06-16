# Phase 1 — Claude Code kickoff prompt

Paste the block below into Claude Code, with this repo (`Life/jigzle`) open as the working folder.

---

You are working on the Jigzle operations web app — this repo is the existing Turborepo monorepo
(Next.js + Supabase/Postgres + Vercel, Google OAuth). You are already inside it; treat the current
folder as the repo root. App code is in apps/<name> (the "calculator" app already ships), shared
code in packages/{ui,lib,db}, and Supabase migrations in supabase/migrations/. Do not create code
inside any Google Drive sync folder.

We are starting Phase 1 of migrating Jigzle's operations off a broken Google Sheets system into
this app. READ THESE FIRST, end to end:
- docs/migration-scope.md  — the full plan (tables, stock engine, modules, build order).
- DATA_SOURCES.md          — where the source data lives.
- supabase/migrations/0001_init.sql and 0002_seed.sql — match the existing schema, snake_case
  naming, and the RLS pattern (is_allowed_user() reads the email from auth.jwt(), not auth.users).
The source spreadsheets (the 5 main sheets + full SheetDev) are in migration/ as .xlsx, for reference.

THIS SESSION'S GOAL — the database foundation only:
Design and write new Supabase migration(s) for the Phase-1 schema plus the stock engine.
No UI and no data import yet. Build the schema in dependency order:

  1. catalogue + brands + barcodes + sku_sources   (the spine)
  2. customers + customer_addresses
  3. orders + order_lines + payments + holds        (Sales)
  4. inbound                                         (Receiving)
  5. suppliers + forwarders + shipments + purchase_orders + missing_pieces  (Procurement)
  6. price_groups + pricing_config + royalty_rates(empty) + royalty_paid + outbound_shipments + boxes
  7. the STOCK ENGINE as a SQL view (below)

Critical rules that shape the schema (details in docs/migration-scope.md):
- item_code is the universal primary key / FK. ~47k SKUs, globally unique.
- barcodes: one SKU can have many barcodes; each barcode is UNIQUE and points to one SKU.
  Enforce uniqueness; collisions get a suffix (handled in app, but the constraint lives here).
- customers.phone is normalized (country code, no leading 0) and UNIQUE — it's the dedup key.
- Sales is split: orders (one per sales_id) + order_lines (line_id = the old "Encrypt") + a
  separate payments table (DP and full payments). Cancelled orders are kept, never deleted.
- holds reduce available stock and auto-release on fulfill.
- inbound has an `excluded` flag (gift/damaged -> 0 stock) and an `is_opening_balance` flag
  (the "Up to 2023" rows). ship_id is nullable (legacy) and is the join key to shipments.
- Derived values (size_all, dim_all, vol_weight = P x L x T / 6000) are computed, not stored.
- Stock is a VIEW, not a stored number. Per SKU:
    available    = sum inbound(not excluded) - sum fulfilled - sum holds
    physical     = sum inbound(not excluded) - sum shipped
    reserved     = sum fulfilled - sum shipped
    pending      = sum purchase_orders where status='Processing'
    on_the_way   = sum purchase_orders where status in ('On the way','With Forwarder')
    last_receive = max(inbound.receive_date)
  This view is the "Stock Check" screen.

APPROACH:
First propose the full table DDL (columns, types, keys, FKs, indexes, constraints) and the
stock-engine view design as a plan for me to review — do NOT write all the SQL until I approve
the design. Flag any modeling choices or trade-offs you want my call on. Then implement as
properly ordered migration files following the existing conventions, with RLS policies.

OUT OF SCOPE this session: UI modules, data import/lift, marketplace, pictures, customer portal,
royalty values. Schema + stock view only.
