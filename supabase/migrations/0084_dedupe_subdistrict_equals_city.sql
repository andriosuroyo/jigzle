-- 0084 — PR331 data backfill on customer_addresses (idempotent, safe to re-run). Companion to 0083.
--
-- When a saved address's Subdistrict (kecamatan) is the EXACT same value as its City/District (kota) —
-- e.g. kecamatan Karanganyar inside kabupaten Karanganyar — the Subdistrict is a redundant repeat of the
-- level above. Blank it (the single City name still conveys it; couriers lose nothing) and collapse the
-- doubled token in raw_address. Combined with 0083 (Ward == Subdistrict) this fully collapses a run of
-- same-named levels (e.g. Kuningan/Kuningan/Kuningan → keep City only).
--
-- Dry-run first (see the SELECT pasted in chat) to preview how many rows this touches.

begin;

update customer_addresses
set raw_address = replace(raw_address, btrim(kecamatan) || ', ' || btrim(kota), btrim(kota)),
    kecamatan   = null
where kota is not null and kecamatan is not null
  and btrim(kecamatan) <> ''
  and lower(btrim(kecamatan)) = lower(btrim(kota));

commit;
