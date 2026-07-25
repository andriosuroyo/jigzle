# Outbound weight repair — June 2026 (Sheet 39) + missing-weight audit

Repair run 2026-07-24. Two migrations belong to this work:
`0122_restore_sheet39_weights.sql` (the June data restore, already applied via the API — the file is the
paper trail) and `0121_weight_waived.sql` (the accepted-blank marker, **still to be run**).

## 1. What was broken

All 99 outbound item rows shipped **15–30 Jun 2026** had `outbound_shipments.weight_gram` null. They came
from a bulk import off the hand-maintained "Sheet 39" Google Sheet, whose column layout shifts partway
through the month (weight sits in col 8, 9, 11 or 13 depending on the block), so the importer read it as
empty. Clean boundary: everything ≤ 13 Jun has a weight, everything 15–30 Jun did not.

99 item rows = **51 shipments**.

## 2. How the weights were read back

A weight is a bare 3–5 digit integer sitting to the **right** of the address/courier/date cells. The traps:
a barcode is also a bare integer but 10–13 digits and sits **left** of the address; a tracking number can be
4 digits; cells to the right can hold notes (`DISPLIT 2 BOX`, `41.5 x 32 x 16.5 cm`). Position, not a fixed
column index, is what identifies it.

**Matching.** The DB stores the sheet's **col-0 customer name** in `recipient_name`, *not* the address
receiver — so `Dewi (6399)`, `Suadela (1885)` and `Huang Rita` are the recipient in the DB. Matching on
`ship_date + col-0 name` resolved **all 51 groups to exactly one shipment**, with every group's SKU count
equal to its DB row count. No fuzzy matching was needed; nothing was ambiguous or unmatched.

**Splits.** A shipment split across boxes stores **one weight per box**, repeated across that box's SKU
rows — the existing convention (114 prior shipments do this). Box weights are never summed.
Restored splits: Ririn Widyastuti 17/6 (8575 + 3947), Pamela Rosandi 17/6 (8570 + 4181), Francisca 24/6
(4402 + 4025), Yenny Karim 25/6 (5172 + 3644), Agata Rita 27/6 (4567 + 3009).

**Resolved ambiguity.** Agata Rita 17/6 showed `2057` on two rows. The TIKI invoice bills that line as
**1 piece, 2 kg** — so it is one box of 2057 g repeated across two SKU rows, not two boxes.

## 3. Result

- **91 rows across 44 shipments restored.** Verified: stored values match intended values exactly.
- **8 rows across 7 shipments left blank** — the sheet never recorded a weight for them: the whole 18 Jun
  batch (Huang Rita, Ciko, Kelvin, Suci, Monica C), Muthia CF 29/6, Ayu Zenobia 30/6.
- Backup of all 99 pre-write rows and a per-row provenance log (shipment_id → weight → source CSV rows)
  were kept for the run; the provenance is also inlined as comments in `0122`.

## 4. Invoice cross-check

`billed_kg = max(1, ceil((grams - 300) / 1000))` against the June TIKI invoice. All TIKI lines agree
except three, all consistent with TIKI billing volumetric weight (max of actual and volumetric):

| Date | Shipment | Sheet | → billed | Invoice |
|---|---|---|---|---|
| 30 Jun | REPACK.ID / Janita K | 5,851 g | 6 kg | 7 kg |
| 30 Jun | Ralita Maya | 2,453 g | 3 kg | 4 kg |
| 19 Jun | Meliyana H | 1,365 g | 2 kg | 1 kg |

The sheet weights are the actual weights and are what belong in `weight_gram`; the invoice difference is a
billing artifact, not a data error.

## 5. Two weight storage models — important

There are **two** places an outbound weight lives, and a report must handle both:

| Source | Weight lives in | Joined by |
|---|---|---|
| CSV / legacy import (to Jun 2026) | `outbound_shipments.weight_gram` | — |
| App ship (`record_shipment`, Jul 2026 →) | `boxes.chargeable_weight` | `send_id` |

`record_shipment` deliberately does **not** write `weight_gram`; app-era rows carry it in `boxes`. So a
null `weight_gram` on a row that has a `send_id` is **expected and correct**, not missing data. Both real
reports already join `boxes` (`getOutboundHistory`, `fetchMonthlyShipments`) and show these weights
correctly. Any future audit of "missing weights" must be boxes-aware or it will report the entire app era
as empty.

## 6. Audit — missing weights, whole table (shipment level, boxes-aware)

5,629 shipments, Oct 2022 → Jul 2026. **154 missing a weight (2.7%).**

The only material gap is **November 2024: 92 of 130 shipments (71%)**. It is import-shaped, not a habit:
ship-days 6–25 Nov are 100% blank across every courier, while 1–2 Nov and 26–30 Nov are 100% clean. That
contiguous window points at a failed bulk import; an old sheet or export for that period likely still holds
the values, recoverable the same way June was.

Everything else is ≤ 9 shipments per month — ordinary noise. July 2026 is **0% missing** once boxes are
counted.

Pre-2025 blanks (794 item rows: 249 in 2022, 160 in 2023, 385 in 2024) are accepted as unrecoverable —
they predate the current warehouse process. `0121` marks them rather than leaving them
indistinguishable from "not yet checked".

## 7. Why the marker is a separate column

`weight_gram` is numeric and feeds the monthly shipment report and the TIKI reconciliation. A placeholder
written there (`0`, `-1`, `1`) becomes a real number in those totals and silently corrupts the courier
comparison — and `0` already reads as "missing" throughout the codebase. The sign-off is an audit fact
about the row, not a weight, so it gets `weight_waived_at` / `weight_waived_reason` and `weight_gram`
stays honestly null.
