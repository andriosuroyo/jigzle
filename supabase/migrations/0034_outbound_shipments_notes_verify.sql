-- 0034 — outbound_shipments becomes the canonical outbound log (it already holds weight_gram +
-- courier; the new report/History will read from here). Add the fields the source CSV carries and
-- the new pipeline captures:
--   • note            — the CSV "Notes" column (gift wrap, free gift, …); per shipment-item.
--   • verify_method   — how the item was checked at ship: 'scan' (barcode ✅) | 'manual' | NULL.
--   • scanned_barcode — the barcode read when verify_method = 'scan' (kept for the report, not shown).
-- All additive + nullable → safe, no backfill required by this migration (the reconcile script fills
-- them from the CSV; the app's Mark-shipped will populate them going forward).

alter table public.outbound_shipments add column if not exists note            text;
alter table public.outbound_shipments add column if not exists verify_method   text;
alter table public.outbound_shipments add column if not exists scanned_barcode text;

-- guard the small domain (NULL allowed)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'outbound_shipments_verify_method_chk') then
    alter table public.outbound_shipments
      add constraint outbound_shipments_verify_method_chk
      check (verify_method is null or verify_method in ('scan', 'manual'));
  end if;
end $$;
