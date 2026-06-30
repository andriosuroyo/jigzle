-- PR113 — Structured-address parse. The legacy import packed each address into one copy-paste blob
-- (`raw_address`: name on the first line, full location in the middle, phone at the end). The new
-- model keeps the location pieces in their own columns (street / kelurahan / … / kode_pos, added in
-- 0004) and treats `raw_address` as a DERIVED display string composed from them (app: addrFields()).
--
-- Two additive columns support the one-time parse (scripts/import/reconcile_addresses.py):
--   • source_blob   — the ORIGINAL import blob, captured once before raw_address is recomposed, as an
--                     immutable audit trail. Never rewritten by the app on save.
--   • delivery_note — courier instructions / "Dari:" sender blocks lifted out of the address body so
--                     they stop polluting the street field (kept out of the composed raw_address).
alter table public.customer_addresses add column if not exists source_blob text;
alter table public.customer_addresses add column if not exists delivery_note text;

-- Preserve every existing blob before the parser overwrites raw_address. One-time, idempotent: only
-- seeds rows not yet captured, so re-running the migration is a no-op.
update public.customer_addresses
   set source_blob = raw_address
 where source_blob is null
   and raw_address is not null;
