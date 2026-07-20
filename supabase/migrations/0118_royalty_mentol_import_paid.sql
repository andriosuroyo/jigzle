-- 0118 — Clover Royalty data (PR393): import Mentol Art's historical royalties, seed its rate schedule,
-- and mark the pre-cutoff backlog paid. Idempotent.
--
-- Context: Mentol Art's sales DO exist as real paid+shipped order_lines (brand CLO, artist 'Mentol Art'),
-- but only Voila Arts was imported into royalty_paid (0008), and Mentol had no rate rows to accrue at.
-- Here we (1) seed Mentol's schedule, (2) load its royalties keyed to the REAL order line_ids with the
-- payout dates from the old Sales sheet (so the accrual never double-counts them), and (3) mark every
-- remaining unpaid royalty dated before 2026-05-15 as paid (older history is already fully paid).

-- (1) Mentol Art rate schedule (piece count → Rp), from the old sheet. For FUTURE accrual.
insert into public.royalty_rate_rows (entity, pieces, royalty_idr) values
  ('Mentol Art', 35,  60000),
  ('Mentol Art', 63,  75000),
  ('Mentol Art', 300, 120000),
  ('Mentol Art', 500, 140000)
on conflict (entity, pieces) do nothing;

-- The 15 Mentol royalty lines: (real order line_id, royalty Rp, payout date). Year-only payout dates
-- from the sheet are stored as that year's Dec 31 (approximate — the sheet only recorded the year).
-- (2a) correct any rows the live accrual may have already created (unpaid / rate-less), to exact values.
update public.royalty_paid rp
   set partner = 'Mentol Art', royalty_idr = m.royalty_idr, paid_date = m.paid_date::date
  from (values
    ('20250624020614EXADO', 140000, '2025-07-04'),
    ('20250228060211DFOKF', 140000, '2025-03-06'),
    ('20241118PPEXF',       140000, '2025-12-31'),
    ('20240829PFKYN',       140000, '2024-12-31'),
    ('20240821FSJGD',        60000, '2024-12-31'),
    ('20240226FSPSG',        75000, '2024-12-31'),
    ('20231004GRDIT',       120000, '2023-12-31'),
    ('20231004XGSXR',       120000, '2023-12-31'),
    ('20230525JDSGC',        75000, '2023-12-31'),
    ('20230329VZGYV',        60000, '2023-12-31'),
    ('20230227QISSO',        75000, '2023-12-31'),
    ('20230227MNJXR',        75000, '2023-12-31'),
    ('20221012SSCXL',        60000, '2023-12-31'),
    ('20221012SRRHA',        75000, '2023-12-31'),
    ('20221001JHZHZ',        75000, '2023-12-31')
  ) as m(line_id, royalty_idr, paid_date)
 where rp.line_id = m.line_id;

-- (2b) insert any of those 15 still missing, from their real order line (item/qty/date come from it).
insert into public.royalty_paid (line_id, partner, item_code, qty, royalty_idr, fulfill_date, paid_date)
select ol.line_id, 'Mentol Art', ol.item_code, coalesce(ol.qty, 1), m.royalty_idr,
       ol.shipped_at::date, m.paid_date::date
from public.order_lines ol
join (values
    ('20250624020614EXADO', 140000, '2025-07-04'),
    ('20250228060211DFOKF', 140000, '2025-03-06'),
    ('20241118PPEXF',       140000, '2025-12-31'),
    ('20240829PFKYN',       140000, '2024-12-31'),
    ('20240821FSJGD',        60000, '2024-12-31'),
    ('20240226FSPSG',        75000, '2024-12-31'),
    ('20231004GRDIT',       120000, '2023-12-31'),
    ('20231004XGSXR',       120000, '2023-12-31'),
    ('20230525JDSGC',        75000, '2023-12-31'),
    ('20230329VZGYV',        60000, '2023-12-31'),
    ('20230227QISSO',        75000, '2023-12-31'),
    ('20230227MNJXR',        75000, '2023-12-31'),
    ('20221012SSCXL',        60000, '2023-12-31'),
    ('20221012SRRHA',        75000, '2023-12-31'),
    ('20221001JHZHZ',        75000, '2023-12-31')
  ) as m(line_id, royalty_idr, paid_date) on m.line_id = ol.line_id
where not exists (select 1 from public.royalty_paid rp where rp.line_id = ol.line_id);

-- (3) older backlog is already paid: mark every remaining unpaid royalty dated before the cutoff paid,
-- stamping the sold date as an approximate payout date (the exact per-payout dates weren't recorded).
update public.royalty_paid
   set paid_date = fulfill_date
 where paid_date is null and fulfill_date is not null and fulfill_date < date '2026-05-15';
