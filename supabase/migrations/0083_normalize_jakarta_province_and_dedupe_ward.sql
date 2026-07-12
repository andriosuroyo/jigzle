-- 0083 — PR330 data backfill on customer_addresses (idempotent, safe to re-run).
--
--   1. Rename the Greater-Jakarta province to "Jawa Barat" everywhere it appears:
--        • the `provinsi` column
--        • the composed `raw_address` display string (what Outbound prints verbatim)
--      `source_blob` (the immutable "Original address — from old database" blob) is left UNTOUCHED
--      on purpose, so the historical record stays intact.
--
--   2. When a saved address's Ward (kelurahan) is the EXACT same value as its Subdistrict (kecamatan),
--      blank the Ward (a duplicate lower-level field) and collapse the doubled token in raw_address.
--
-- Dry-run first (see the SELECT pasted in chat) to preview how many rows each step touches.

begin;

-- ── 1a. province column: DKI Jakarta / Daerah Khusus Ibukota Jakarta → Jawa Barat ──
update customer_addresses
set provinsi = 'Jawa Barat'
where btrim(provinsi) in ('Daerah Khusus Ibukota Jakarta', 'DKI Jakarta');

-- ── 1b. the composed raw_address display string (both spellings) ──
update customer_addresses
set raw_address = replace(replace(raw_address,
      'Daerah Khusus Ibukota Jakarta', 'Jawa Barat'),
      'DKI Jakarta', 'Jawa Barat')
where raw_address like '%Daerah Khusus Ibukota Jakarta%'
   or raw_address like '%DKI Jakarta%';

-- ── 2. Ward == Subdistrict → blank the Ward, and de-double the token in raw_address ──
-- (all SET expressions read the pre-update row, so btrim(kelurahan) below is the OLD value even as
--  kelurahan is set to null in the same statement.)
update customer_addresses
set raw_address = replace(raw_address, btrim(kelurahan) || ', ' || btrim(kecamatan), btrim(kecamatan)),
    kelurahan   = null
where kelurahan is not null and kecamatan is not null
  and btrim(kelurahan) <> ''
  and lower(btrim(kelurahan)) = lower(btrim(kecamatan));

commit;
