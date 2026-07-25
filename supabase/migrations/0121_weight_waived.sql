-- PR — mark historical outbound rows whose missing weight has been reviewed and ACCEPTED by the owner,
-- so a blank weight reads as "known-unrecoverable, signed off" rather than "not checked yet".
--
-- Why a separate column and NOT a sentinel in weight_gram: weight_gram is numeric and feeds the monthly
-- shipment report + the TIKI reconciliation. Any placeholder written there (0, -1, 1) becomes a real
-- number in those totals and silently corrupts the courier comparison — and 0 already reads as "missing"
-- everywhere in the codebase. The acceptance is an audit fact about the row, not a weight, so it gets
-- its own field and weight_gram stays honestly null.
--
-- Idempotent / re-runnable.

alter table public.outbound_shipments
  add column if not exists weight_waived_at     timestamptz,
  add column if not exists weight_waived_reason text;

comment on column public.outbound_shipments.weight_waived_at is
  'Non-null = the blank weight_gram on this row has been reviewed and accepted as unrecoverable. Never implies a weight of zero.';

-- Backfill: every pre-2025 row with no weight. These predate the current warehouse process; the owner
-- has signed off that the gaps are expected and not worth chasing. Guarded so re-running is a no-op and
-- so it can NEVER touch a row that actually carries a weight.
update public.outbound_shipments
   set weight_waived_at     = now(),
       weight_waived_reason = 'Legacy system pre-2025 — missing weight accepted by owner'
 where ship_date < date '2025-01-01'
   and (weight_gram is null or weight_gram = 0)
   and weight_waived_at is null;
