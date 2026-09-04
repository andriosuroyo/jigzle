-- 0127 — PR407 follow-up on customer_addresses (idempotent, safe to re-run).
--
-- 33 Jakarta addresses carry a stray "Jawa Barat" stranded in the middle of the composed raw_address —
-- an old bad parse that dropped a region token into the street part (usually as ", Administrasi, Jawa
-- Barat,"), which 0083 then renamed along with everything else. 0126 fixed the real province at the end
-- of the string, so the stray is now just wrong text on the label. Drop it, comma and all.
--
-- Safe because on every one of these rows "Jawa Barat" appears EXACTLY ONCE and the row already ends in
-- the correct ", DKI Jakarta" — so the token being removed can only be the stray, never the province.
-- Guarded by that same condition, so a second run matches nothing. `source_blob` stays untouched.

begin;

update customer_addresses
set raw_address = replace(replace(raw_address, ', Jawa Barat', ''), ',Jawa Barat', '')
where btrim(coalesce(kota, '')) in
        ('Jakarta Barat', 'Jakarta Pusat', 'Jakarta Selatan', 'Jakarta Timur', 'Jakarta Utara', 'Kepulauan Seribu')
  and raw_address like '%Jawa Barat%'
  and raw_address like '%DKI Jakarta%'
  and (length(raw_address) - length(replace(raw_address, 'Jawa Barat', ''))) / 10 = 1;

commit;
