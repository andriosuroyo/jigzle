-- PR — restore the outbound chargeable weights lost by the Sheet 39 bulk import (15–30 Jun 2026).
--
-- The importer read the weight column off a hand-maintained Google Sheet whose column layout
-- shifts partway through the month, so all 99 item rows in that window landed with weight_gram
-- null. The values were recovered from the sheet export and written back on 2026-07-24; this file
-- is the paper trail and lets the repair be reproduced or verified.
--
-- weight_gram is GRAMS, one row per SKU, repeating the shipment-level weight (the existing
-- convention). Split shipments keep one weight PER BOX across that box's rows — they are not summed.
-- Verified against the June TIKI invoice: billed_kg = max(1, ceil((g-300)/1000)) matched on all but
-- three lines, each explainable by volumetric billing (see the repair note in docs/).
--
-- 8 rows are deliberately NOT restored: the sheet itself never recorded a weight for them
-- (the whole 18 Jun batch, Muthia CF 29 Jun, Ayu Zenobia 30 Jun).
--
-- Guarded by `weight_gram is null` so it can never overwrite a real weight and is a no-op on re-run.

update public.outbound_shipments o
   set weight_gram = v.w
  from (values
    (17647, 430),   -- 2026-06-15 Renata virginia  [sheet39 csv rows 14-20]
    (17648, 4360),   -- 2026-06-15 Febrina Mpebs  [sheet39 csv rows 21-27]
    (17649, 2187),   -- 2026-06-15 Agata Rita  [sheet39 csv rows 28-43]
    (17650, 2187),   -- 2026-06-15 Agata Rita  [sheet39 csv rows 28-43]
    (17651, 2187),   -- 2026-06-15 Agata Rita  [sheet39 csv rows 28-43]
    (17652, 2187),   -- 2026-06-15 Agata Rita  [sheet39 csv rows 28-43]
    (17653, 1886),   -- 2026-06-15 Dewi (6399)  [sheet39 csv rows 44-49]
    (17654, 1886),   -- 2026-06-15 Dewi (6399)  [sheet39 csv rows 44-49]
    (17655, 451),   -- 2026-06-15 Helen Angelia (2120)  [sheet39 csv rows 51-58]
    (17656, 2057),   -- 2026-06-17 Agata Rita  [sheet39 csv rows 62-73]
    (17657, 2057),   -- 2026-06-17 Agata Rita  [sheet39 csv rows 62-73]
    (17658, 8571),   -- 2026-06-17 Samantha  [sheet39 csv rows 74-78]
    (17659, 8575),   -- 2026-06-17 Ririn Widyastuti  [sheet39 csv rows 79-84]
    (17660, 3947),   -- 2026-06-17 Ririn Widyastuti  [sheet39 csv rows 85-90]
    (17661, 8570),   -- 2026-06-17 Pamela Rosandi (2036)  [sheet39 csv rows 92-98]
    (17662, 4181),   -- 2026-06-17 Pamela Rosandi (2036)  [sheet39 csv rows 99-105]
    (17663, 565),   -- 2026-06-17 Ratna Maya  [sheet39 csv rows 107-112]
    (17664, 3031),   -- 2026-06-17 Yuli (6111)  [sheet39 csv rows 114-131]
    (17665, 3031),   -- 2026-06-17 Yuli (6111)  [sheet39 csv rows 114-131]
    (17666, 3031),   -- 2026-06-17 Yuli (6111)  [sheet39 csv rows 114-131]
    (17673, 5425),   -- 2026-06-19 Stephanie Danella  [sheet39 csv rows 170-175]
    (17674, 5425),   -- 2026-06-19 Stephanie Danella  [sheet39 csv rows 170-175]
    (17675, 448),   -- 2026-06-19 Monica Ang (1395)  [sheet39 csv rows 176-178]
    (17676, 1199),   -- 2026-06-19 Christine Natalia (8822)  [sheet39 csv rows 179-186]
    (17677, 1199),   -- 2026-06-19 Christine Natalia (8822)  [sheet39 csv rows 179-186]
    (17678, 1365),   -- 2026-06-19 Meliyana H (2599)  [sheet39 csv rows 187-189]
    (17679, 3939),   -- 2026-06-20 Martha D (5880)  [sheet39 csv rows 192-197]
    (17680, 8570),   -- 2026-06-20 Samrina Nanwani (1325)  [sheet39 csv rows 198-203]
    (17681, 784),   -- 2026-06-20 Farina T (2865)  [sheet39 csv rows 204-213]
    (17682, 784),   -- 2026-06-20 Farina T (2865)  [sheet39 csv rows 204-213]
    (17683, 1067),   -- 2026-06-20 Agatha (7071)  [sheet39 csv rows 214-216]
    (17684, 8067),   -- 2026-06-22 Fahma aldihyah  [sheet39 csv rows 219-232]
    (17685, 8067),   -- 2026-06-22 Fahma aldihyah  [sheet39 csv rows 219-232]
    (17686, 1058),   -- 2026-06-22 JillCandranegara  [sheet39 csv rows 233-238]
    (17687, 2455),   -- 2026-06-22 Yenny V (4197)  [sheet39 csv rows 239-243]
    (17688, 1425),   -- 2026-06-22 Lenny (2109)  [sheet39 csv rows 244-249]
    (17689, 2980),   -- 2026-06-23 Suadela (1885)  [sheet39 csv rows 252-261]
    (17690, 2980),   -- 2026-06-23 Suadela (1885)  [sheet39 csv rows 252-261]
    (17691, 3936),   -- 2026-06-23 Olivia  [sheet39 csv rows 262-268]
    (17692, 4402),   -- 2026-06-24 Francisca (1117)  [sheet39 csv rows 271-276]
    (17693, 4025),   -- 2026-06-24 Francisca (1117)  [sheet39 csv rows 277-282]
    (17694, 4092),   -- 2026-06-24 Hanny Thiorisa (0202)  [sheet39 csv rows 283-288]
    (17695, 5172),   -- 2026-06-25 Yenny Karim (6000)  [sheet39 csv rows 291-301]
    (17696, 5172),   -- 2026-06-25 Yenny Karim (6000)  [sheet39 csv rows 291-301]
    (17697, 5172),   -- 2026-06-25 Yenny Karim (6000)  [sheet39 csv rows 291-301]
    (17698, 5172),   -- 2026-06-25 Yenny Karim (6000)  [sheet39 csv rows 291-301]
    (17699, 5172),   -- 2026-06-25 Yenny Karim (6000)  [sheet39 csv rows 291-301]
    (17700, 3644),   -- 2026-06-25 Yenny Karim (6000)  [sheet39 csv rows 302-314]
    (17701, 3644),   -- 2026-06-25 Yenny Karim (6000)  [sheet39 csv rows 302-314]
    (17702, 3644),   -- 2026-06-25 Yenny Karim (6000)  [sheet39 csv rows 302-314]
    (17703, 3644),   -- 2026-06-25 Yenny Karim (6000)  [sheet39 csv rows 302-314]
    (17704, 3644),   -- 2026-06-25 Yenny Karim (6000)  [sheet39 csv rows 302-314]
    (17705, 3644),   -- 2026-06-25 Yenny Karim (6000)  [sheet39 csv rows 302-314]
    (17706, 3644),   -- 2026-06-25 Yenny Karim (6000)  [sheet39 csv rows 302-314]
    (17707, 3644),   -- 2026-06-25 Yenny Karim (6000)  [sheet39 csv rows 302-314]
    (17708, 1728),   -- 2026-06-25 Hertaty Novianty (0487)  [sheet39 csv rows 315-319]
    (17709, 975),   -- 2026-06-25 Amanda TA (5889)  [sheet39 csv rows 321-334]
    (17710, 975),   -- 2026-06-25 Amanda TA (5889)  [sheet39 csv rows 321-334]
    (17711, 450),   -- 2026-06-25 Vero Wijaya  [sheet39 csv rows 335-341]
    (17712, 2350),   -- 2026-06-25 Ruth Balderas  [sheet39 csv rows 342-347]
    (17713, 10064),   -- 2026-06-25 Cucu  [sheet39 csv rows 348-375]
    (17714, 10064),   -- 2026-06-25 Cucu  [sheet39 csv rows 348-375]
    (17715, 10064),   -- 2026-06-25 Cucu  [sheet39 csv rows 348-375]
    (17716, 10064),   -- 2026-06-25 Cucu  [sheet39 csv rows 348-375]
    (17717, 265),   -- 2026-06-25 Ricky Shonda (6301)  [sheet39 csv rows 376-383]
    (17718, 4165),   -- 2026-06-26 Nauravira Amalina Rakhmatsyah  [sheet39 csv rows 386-390]
    (17719, 4567),   -- 2026-06-27 Agata Rita  [sheet39 csv rows 393-434]
    (17720, 4567),   -- 2026-06-27 Agata Rita  [sheet39 csv rows 393-434]
    (17721, 4567),   -- 2026-06-27 Agata Rita  [sheet39 csv rows 393-434]
    (17722, 4567),   -- 2026-06-27 Agata Rita  [sheet39 csv rows 393-434]
    (17723, 4567),   -- 2026-06-27 Agata Rita  [sheet39 csv rows 393-434]
    (17724, 4567),   -- 2026-06-27 Agata Rita  [sheet39 csv rows 393-434]
    (17725, 3009),   -- 2026-06-27 Agata Rita  [sheet39 csv rows 435-455]
    (17726, 3009),   -- 2026-06-27 Agata Rita  [sheet39 csv rows 435-455]
    (17727, 3009),   -- 2026-06-27 Agata Rita  [sheet39 csv rows 435-455]
    (17728, 2311),   -- 2026-06-27 Meyyani L (8883)  [sheet39 csv rows 456-469]
    (17729, 2311),   -- 2026-06-27 Meyyani L (8883)  [sheet39 csv rows 456-469]
    (17730, 1115),   -- 2026-06-27 Inggrid Haley (5224)  [sheet39 csv rows 470-474]
    (17731, 1076),   -- 2026-06-29 Cynthia Wijaya  [sheet39 csv rows 477-483]
    (17733, 1928),   -- 2026-06-29 Julyani (2173)  [sheet39 csv rows 490-494]
    (17735, 2453),   -- 2026-06-30 Ralita Maya (5985  [sheet39 csv rows 503-507]
    (17736, 5851),   -- 2026-06-30 Janita K (0052)  [sheet39 csv rows 508-522]
    (17737, 5851),   -- 2026-06-30 Janita K (0052)  [sheet39 csv rows 508-522]
    (17738, 5851),   -- 2026-06-30 Janita K (0052)  [sheet39 csv rows 508-522]
    (17739, 5851),   -- 2026-06-30 Janita K (0052)  [sheet39 csv rows 508-522]
    (17740, 5851),   -- 2026-06-30 Janita K (0052)  [sheet39 csv rows 508-522]
    (17741, 5851),   -- 2026-06-30 Janita K (0052)  [sheet39 csv rows 508-522]
    (17742, 5851),   -- 2026-06-30 Janita K (0052)  [sheet39 csv rows 508-522]
    (17743, 5851),   -- 2026-06-30 Janita K (0052)  [sheet39 csv rows 508-522]
    (17744, 1102),   -- 2026-06-30 Ferina sofianti  [sheet39 csv rows 523-529]
    (17745, 1033)   -- 2026-06-30 Elis Octavia  [sheet39 csv rows 530-535]
  ) as v(shipment_id, w)
 where o.shipment_id = v.shipment_id
   and o.weight_gram is null;

