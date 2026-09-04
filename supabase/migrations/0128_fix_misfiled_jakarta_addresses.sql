-- 0128 — PR407 follow-up on customer_addresses (idempotent, safe to re-run).
--
-- Seven addresses that are really in Jakarta were filed under a completely different city: the old
-- dissector matched a WARD name and jumped to a same-named place in another province (ward "Kuningan
-- Timur" → kota Kuningan, Jawa Barat; ward "Lorong" → Sambas; "Kesehatan" → Aceh Tamiang; and so on).
-- Each row's `source_blob` — the untouched original — names the real Jakarta location, so each fix below
-- comes from that blob, never from guesswork.
--
-- The same mis-parse also ATE a word out of `street` (it became the bogus ward), so the street is
-- restored from the blob too, and the region words the blob repeated inside the street are dropped now
-- that the proper fields carry them. Anything the blob does not pin down (a ward when the postcode spans
-- several, a postcode the dataset doesn't list) is left NULL rather than invented.
--
-- Two more rows from the same family are NOT here — 4997 and 5054, where the blob contradicts itself
-- about whether the address is in Jakarta at all. Those need a human call.

begin;

-- Jl. Jembatan Dua, Penjaringan, Jakarta Utara 14450 — was: Kaur, Bengkulu 38963
update customer_addresses set
  street = 'Sinar Budi, Jl. I No.15C RT.08/03, Jembatan Dua', kelurahan = null,
  kecamatan = 'Penjaringan', kota = 'Jakarta Utara', provinsi = 'DKI Jakarta', kode_pos = '14450'
where address_id = 1466;

-- Bea & Cukai HQ, Jakarta Timur 13231 — was: Ketapang, Kalimantan Barat 78811
update customer_addresses set
  street = 'Kantor Pusat Direktorat Jenderal Bea dan Cukai, Jl. Jend. A. Yani (Bypass), Gedung Papua Lantai 2',
  kelurahan = null, kecamatan = null, kota = 'Jakarta Timur', provinsi = 'DKI Jakarta', kode_pos = '13231'
where address_id = 2545;

-- Jl. Kesehatan IV, Pesanggrahan, Jakarta Selatan — was: Aceh Tamiang, Aceh 24476
update customer_addresses set
  street = 'Jl. Kesehatan IV No. 101', kelurahan = null,
  kecamatan = 'Pesanggrahan', kota = 'Jakarta Selatan', provinsi = 'DKI Jakarta', kode_pos = null
where address_id = 6711;

-- Jl. Deli Lorong, Koja, Jakarta Utara 14220 — was: Sambas, Kalimantan Barat 79462
update customer_addresses set
  street = 'Jl. Deli Lorong 28 No.7 RT.009/03', kelurahan = null,
  kecamatan = 'Koja', kota = 'Jakarta Utara', provinsi = 'DKI Jakarta', kode_pos = '14220'
where address_id = 6889;

-- Jl. Taman Patra 3 No.9 — was: Pemalang, Jawa Tengah 52361. The ward comes from address 7393 below,
-- the same street and house number, whose blob spells out "Setiabudi, Kuningan Timur".
update customer_addresses set
  street = 'Jln. Taman Patra 3 No.9', kelurahan = 'Kuningan Timur',
  kecamatan = 'Setia Budi', kota = 'Jakarta Selatan', provinsi = 'DKI Jakarta', kode_pos = '12950'
where address_id = 7380;

-- Jl. Taman Patra 3 no 9, Kuningan Timur, Setiabudi — was: Kuningan, Jawa Barat 45511
update customer_addresses set
  street = 'Jl. Taman Patra 3 no 9', kelurahan = 'Kuningan Timur',
  kecamatan = 'Setia Budi', kota = 'Jakarta Selatan', provinsi = 'DKI Jakarta', kode_pos = '12950'
where address_id = 7393;

-- Kuningan City, Jl. Prof. Dr. Satrio, Setiabudi — was: Kuningan, Jawa Barat 45511. The blob names only
-- the SUBDISTRICT ("SETIA BUDI"), so the ward and postcode stay blank.
update customer_addresses set
  street = 'Kuningancity management office, kuningan city mall lantai LG, Jl. Prof Dr. Satrio kav 18',
  kelurahan = null, kecamatan = 'Setia Budi', kota = 'Jakarta Selatan', provinsi = 'DKI Jakarta', kode_pos = null
where address_id = 7403;

-- recompose the display string exactly as the app does (addrFields in app/customers/actions.ts)
update customer_addresses
set raw_address = nullif(array_to_string(array_remove(
      array[nullif(street, ''), nullif(kelurahan, ''), nullif(kecamatan, ''), nullif(kota, ''),
            nullif(provinsi, ''), nullif(negara, ''), nullif(kode_pos, '')], null), ', '), '')
where address_id in (1466, 2545, 6711, 6889, 7380, 7393, 7403);

commit;
