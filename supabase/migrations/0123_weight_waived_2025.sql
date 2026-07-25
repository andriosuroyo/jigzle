-- PR — extend the accepted-blank marker (0121) to 2025.
--
-- 0121 waived the pre-2025 blanks (794 rows) as legacy-system gaps. This covers the 27 remaining
-- blank rows in 2025 — 8 shipments across 7 ship-days (31 Jan, 7 + 18 Feb, 28 Mar, 30 May, 14 Jul,
-- 16 Aug). Unlike the June 2026 and Nov 2024 gaps these are scattered one-offs, not an import
-- window: isolated shipments logged without a weight under the pre-app manual process. Nothing to
-- recover, so the owner has accepted them.
--
-- Separate reason text from 0121 so the two causes stay distinguishable in the data.
-- Applied via the API 2026-07-25; this file is the paper trail.
--
-- Guarded on `weight_waived_at is null` and on the row actually being blank, so it is a no-op on
-- re-run and can never mark a row that carries a real weight.

update public.outbound_shipments
   set weight_waived_at     = now(),
       weight_waived_reason = 'Pre-app manual logging 2025 — isolated missing weight accepted by owner'
 where ship_date >= date '2025-01-01'
   and ship_date <  date '2026-01-01'
   and (weight_gram is null or weight_gram = 0)
   and weight_waived_at is null;
