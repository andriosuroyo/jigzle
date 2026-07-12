-- 0085 — PR336 data backfill on customer_addresses (idempotent, safe to re-run). Companion to 0083/0084.
--
-- When a saved address's Ward (kelurahan) is the EXACT same value as its City/District (kota) — e.g.
-- kelurahan Metro inside Kota Metro (with kecamatan "Metro Pusat" in between, so it's a non-adjacent
-- repeat) — the Ward is a redundant repeat of a coarser anchor. Blank it (the City still conveys it;
-- couriers lose nothing) and remove the Ward token from raw_address.
--
-- In raw_address the Ward (kelurahan) is composed immediately before the Subdistrict (kecamatan), or
-- before the City (kota) when the Subdistrict is empty — so we drop "<ward>, <next>" → "<next>".
--
-- Dry-run first (see the SELECT pasted in chat) to preview how many rows this touches.

begin;

update customer_addresses
set raw_address = replace(
      raw_address,
      btrim(kelurahan) || ', ' || btrim(coalesce(nullif(btrim(kecamatan), ''), kota)),
      btrim(coalesce(nullif(btrim(kecamatan), ''), kota))
    ),
    kelurahan = null
where kelurahan is not null and kota is not null
  and btrim(kelurahan) <> ''
  and lower(btrim(kelurahan)) = lower(btrim(kota));

commit;
