-- apply-0020.sql
-- Paste-ready for the Supabase SQL editor (ref tocmwitawwtxmnwrbyab). Run it once.
-- SQL is identical to supabase/migrations/0020_barcodes_multi.sql; only this banner is added.
--
-- What it does: changes barcodes from one-SKU-per-barcode to a proper composite key
-- (barcode, item_code) — one barcode can link to many SKUs — and adds the barcode_collisions
-- view (the shared barcodes, for the Stage-2 editor). On today's data the swap is ZERO-change
-- (every barcode is currently unique); it just unlocks the composite model so the dropped
-- collision pairs can be bulk-restored.
--
-- Idempotent: re-running is safe (the PK swap is guarded on the single-column shape, the view is
-- create-or-replace, grants are repeatable). It does NOT touch catalogue, stock_check, the
-- importer, or any RPC.
--
-- After this runs: (1) Receiving's resolveBarcode shows the picker for any shared barcode, and
-- (2) run the additive bulk-restore on your Mac to load the dropped pairs:
--     python3 scripts/import/sync_barcodes.py            # dry-run (default) — reports the to-add set
--     python3 scripts/import/sync_barcodes.py --execute  # insert the missing (barcode, item_code) pairs

-- ============================================================================
-- 0020_barcodes_multi.sql
-- ============================================================================

-- ============== swap PK: (barcode) → (barcode, item_code) ==============
do $$
begin
  -- Act only while the PK is still the single-column (barcode) form. Once composite, re-runs skip
  -- this block. The whole DO block is one transactional statement, so a mid-way failure rolls back
  -- cleanly (no half-swapped state).
  if exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.barcodes'::regclass
      and c.contype = 'p'
      and c.conname = 'barcodes_pkey'
      and array_length(c.conkey, 1) = 1
  ) then
    alter table public.barcodes drop constraint barcodes_pkey;

    -- Defensive '#n' normalization (a no-op on today's data — no '#n' rows exist): collapse any
    -- '<bc>#n' back to the bare code, then drop exact-duplicate (barcode, item_code) pairs keeping
    -- one, so the composite PK can be added cleanly even if a prior '#n'-style load had run.
    update public.barcodes set barcode = split_part(barcode, '#', 1) where barcode like '%#%';

    delete from public.barcodes b
    using public.barcodes d
    where b.ctid < d.ctid
      and b.barcode = d.barcode
      and b.item_code = d.item_code;

    alter table public.barcodes add primary key (barcode, item_code);
  end if;
end $$;

-- ============== barcode_collisions view (read by Stage 2 / PR-B) ==============
-- The shared barcodes: each barcode linked to >1 SKU, with the owner list. security_invoker so the
-- querying user's RLS on barcodes applies. Harmless until the editor reads it.
create or replace view public.barcode_collisions
  with (security_invoker = true)
as
select barcode,
       count(*) as n,
       array_agg(item_code order by item_code) as item_codes
from public.barcodes
group by barcode
having count(*) > 1;

-- New entities are not auto-exposed (see supabase/config.toml), so grant read explicitly: the
-- signed-in operator (authenticated) + the service role (smoke harness); never anon.
revoke all on public.barcode_collisions from anon;
grant select on public.barcode_collisions to authenticated, service_role;

-- Confirm: should be 0 today (no shared barcodes yet), then ~77 after the sync --execute run.
-- select count(*) as shared_barcodes from public.barcode_collisions;
