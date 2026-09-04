-- 0126 — PR407 data fix on customer_addresses (idempotent, safe to re-run).
--
-- Undoes step 1 of migration 0083 (PR330), which renamed Jakarta's province to "Jawa Barat" everywhere.
-- That was wrong: the five Jakarta cities (plus Kepulauan Seribu) are their OWN province, not part of
-- Jawa Barat. They are stored as "DKI Jakarta" — the short spelling people actually write; the postal
-- dataset's long "Daerah Khusus Ibukota Jakarta" is shortened to it by `normalizeProvince` on entry and
-- on save, so one spelling wins and this doesn't become whack-a-mole.
--
-- `source_blob` (the immutable "Original address — from old database" blob) stays UNTOUCHED, as in 0083.
-- Steps 1-2 cover the 2,714 structured Jakarta addresses; step 3 repairs six free-text rows whose
-- raw_address had the words "DKI Jakarta" overwritten by 0083 (their source_blob proves the original).

begin;

-- ── 1. the province column + the composed raw_address display string, for a Jakarta city ──
-- (all SET expressions read the pre-update row, so btrim(kota) and provinsi below are the OLD values.)
update customer_addresses
set raw_address = replace(replace(raw_address,
      btrim(kota) || ', Daerah Khusus Ibukota Jakarta', btrim(kota) || ', DKI Jakarta'),
      btrim(kota) || ', Jawa Barat',                    btrim(kota) || ', DKI Jakarta'),
    provinsi = 'DKI Jakarta'
where btrim(coalesce(kota, '')) in
        ('Jakarta Barat', 'Jakarta Pusat', 'Jakarta Selatan', 'Jakarta Timur', 'Jakarta Utara', 'Kepulauan Seribu')
  and btrim(coalesce(provinsi, '')) in ('Jawa Barat', 'Daerah Khusus Ibukota Jakarta');

-- ── 2. any stray long spelling left in a province column elsewhere → the short one ──
update customer_addresses
set provinsi = 'DKI Jakarta'
where btrim(provinsi) = 'Daerah Khusus Ibukota Jakarta';

-- ── 3. six free-text rows: restore the "DKI Jakarta" that 0083 rewrote to "Jawa Barat" ──
-- Each row's kota/provinsi are separately wrong (a bad autofill pick put them in Kuningan, Pemalang, …)
-- or empty; that is a different defect and is NOT touched here — only the overwritten words are restored.
-- `replace` on an absent fragment is a no-op, so re-running is safe.
update customer_addresses set raw_address = replace(raw_address, 'Jakarta Timur, Jawa Barat',      'Jakarta Timur, DKI Jakarta')      where address_id = 6841;
update customer_addresses set raw_address = replace(raw_address, 'Jawa Barat, Indonesia',          'DKI Jakarta, Indonesia')          where address_id = 7062;
update customer_addresses set raw_address = replace(raw_address, 'Setiabudi Jawa Barat',           'Setiabudi DKI Jakarta')           where address_id = 7380;
update customer_addresses set raw_address = replace(raw_address, 'Administrasi, Jawa Barat',       'Administrasi, DKI Jakarta')       where address_id = 7385;
update customer_addresses set raw_address = replace(raw_address, 'Jakarta Utara, Jawa Barat 14450', 'Jakarta Utara, DKI Jakarta 14450') where address_id = 7386;
update customer_addresses set raw_address = replace(raw_address, 'Jakarta Selatan, Jawa Barat',    'Jakarta Selatan, DKI Jakarta')    where address_id = 7393;

commit;
