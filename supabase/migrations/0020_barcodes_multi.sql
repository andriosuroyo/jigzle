-- Phase 1 — Barcode model: one barcode → many SKUs (composite key). Stage 1 of docs/010.
-- Today barcodes.barcode is the single-column PK (one SKU per barcode), so a physically shared
-- barcode can't be represented — the original import kept only the first owner and the rest were
-- faked with a '#n' suffix. This swaps the PK to composite (barcode, item_code): a barcode can
-- legitimately link to N SKUs, and Receiving's resolveBarcode shows the "which SKU?" picker
-- whenever a scan hits >1 — honestly from the data, no suffix. Existing rows all have unique
-- barcodes, so the composite PK holds with ZERO data change today.
--
-- Idempotent / re-runnable: the PK swap is guarded on the current (single-column) shape, the view
-- is create-or-replace, and the grants are repeatable. Does NOT touch catalogue, stock_check, the
-- importer, or any other module's RPC. (barcodes_item_code_idx from 0003 still serves per-SKU
-- lookups — kept.)

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
