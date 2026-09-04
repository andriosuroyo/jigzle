-- 0129 — PR407 follow-up on customer_addresses (idempotent, safe to re-run).
--
-- Sixteen Jakarta addresses were never broken into fields — they carry free text only, with no city and
-- no province, so they miss every region check. This fills in EXACTLY what each row's untouched
-- `source_blob` names and nothing more: the ward and subdistrict only where the blob spells them out,
-- the postcode only where the blob states it (never derived from a ward, never guessed), and otherwise
-- just the city plus "DKI Jakarta". Rows left without a postcode will surface in the Fix tab's
-- missing-postcode list, which suggests one from the dataset — that stays an operator decision.
--
-- `street` is trimmed of the region words the proper fields now carry, and words the old dissector ate
-- are restored from the blob ("Kebon Jeruk" on 7412, "Pluit" on 7385).

begin;

-- ── city + province only (the blob names no ward or subdistrict) ──
update customer_addresses set street = 'Katamaran Indah 2 No.31, Pantai Indah Kapuk',
  kota = 'Jakarta Utara',   provinsi = 'DKI Jakarta' where address_id = 58;
update customer_addresses set street = 'Verde apartment, South Tower Unit 1110, Jl. Haji Cokong',
  kota = 'Jakarta Selatan', provinsi = 'DKI Jakarta' where address_id = 62;
update customer_addresses set street = 'The Royale Springhill Residence Tower Marygold Lantai 3D, Jl. Benyamin Suaeb',
  kota = 'Jakarta Utara',   provinsi = 'DKI Jakarta' where address_id = 76;
update customer_addresses set street = 'Gading Residence Jl. Pelangi jingga blok D5S No.8',
  kota = 'Jakarta Utara',   provinsi = 'DKI Jakarta' where address_id = 1447;
update customer_addresses set street = 'Taman surya 5 ruko pasar laris palm paradise blok H no 8',
  kota = 'Jakarta Barat',   provinsi = 'DKI Jakarta' where address_id = 2726;
update customer_addresses set street = 'Green Ville blok P No.20',
  kota = 'Jakarta Barat',   provinsi = 'DKI Jakarta' where address_id = 6565;
update customer_addresses set street = 'Anandamaya Residence, Tower 2 Unit 6D, Jl. Jenderal Sudirman No 5',
  kota = 'Jakarta Pusat',   provinsi = 'DKI Jakarta' where address_id = 7399;

-- ── the blob names a subdistrict too ──
update customer_addresses set street = 'Golden Rama Tour - Jl. Boulevard Barat Raya Blok LA-1 No 26-27',
  kecamatan = 'Kelapa Gading',  kota = 'Jakarta Utara',   provinsi = 'DKI Jakarta' where address_id = 7407;
update customer_addresses set street = 'Pakubuwono Resindence Unit B10E',
  kecamatan = 'Kebayoran Baru', kota = 'Jakarta Selatan', provinsi = 'DKI Jakarta' where address_id = 7455;
-- 7385 and 7386 are the same address entered twice for the same customer (2946); both are filled the
-- same way here and de-duplicating them is left to the operator. The blob gives the subdistrict and the
-- postcode but not the ward (14450 covers both Pluit and Pejagalan), so the ward stays blank.
update customer_addresses set street = 'Pluit Timur Residence, Blok G Utara No. 1 (Pagar Rumah tembok dari batu alam)',
  kecamatan = 'Penjaringan', kota = 'Jakarta Utara', provinsi = 'DKI Jakarta', kode_pos = '14450'
where address_id in (7385, 7386);

-- ── the blob spells out the ward as well (ward spelling follows the postal dataset) ──
update customer_addresses set street = 'Jl. Kebon Pala I Gang Damai No. 11a, RT.2/RW.5',
  kelurahan = 'Bidaracina', kecamatan = 'Jatinegara', kota = 'Jakarta Timur', provinsi = 'DKI Jakarta'
where address_id = 6841;
update customer_addresses set street = 'Jalan Taman Kebon Jeruk No. Q9-12 (Rumah abu2 pojokan.)',
  kelurahan = 'Srengseng', kecamatan = 'Kembangan', kota = 'Jakarta Barat', provinsi = 'DKI Jakarta'
where address_id = 7412;
update customer_addresses set street = 'Jalan Danau Indah XV Blok B5 No. 38, RT.10/RW.11 (Rumah hook, putih)',
  kelurahan = 'Sunter Jaya', kecamatan = 'Tanjung Priok', kota = 'Jakarta Utara', provinsi = 'DKI Jakarta'
where address_id = 7440;
update customer_addresses set street = 'Perum. Citra Garden Puri, Cluster Elecio Blok EA/05. RT 07/ RW 03.',
  kelurahan = 'Semanan', kecamatan = 'Kalideres', kota = 'Jakarta Barat', provinsi = 'DKI Jakarta',
  kode_pos = '11850'
where address_id = 7450;

-- ── the blob is a province and nothing else — record that, claim no more ──
update customer_addresses set street = null, provinsi = 'DKI Jakarta' where address_id = 7062;

-- recompose the display string exactly as the app does (addrFields in app/customers/actions.ts)
update customer_addresses
set raw_address = nullif(array_to_string(array_remove(
      array[nullif(street, ''), nullif(kelurahan, ''), nullif(kecamatan, ''), nullif(kota, ''),
            nullif(provinsi, ''), nullif(negara, ''), nullif(kode_pos, '')], null), ', '), '')
where address_id in (58, 62, 76, 1447, 2726, 6565, 6841, 7062, 7385, 7386, 7399, 7407, 7412, 7440, 7450, 7455);

commit;
