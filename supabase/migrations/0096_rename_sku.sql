-- 0096 — PR364: rename a SKU's item_code across the WHOLE system in one atomic step, so a mis-typed /
-- mis-cased code can be fixed (e.g. "vin-81380" → "VIN-81380") without stranding any downstream row.
--
-- WHY this is safe as a single UPDATE: every table that FK-references catalogue(item_code) already
-- carries ON UPDATE CASCADE — barcodes, sku_sources (0003), order_lines + the sales line table (0005),
-- inbound (0006), purchase_orders + procurement (0007), pricing + outbound_shipments (0008),
-- stock_check tables (0022). The ONE exception was sku_images (0021), created with ON DELETE CASCADE
-- but no ON UPDATE — part 1 below adds it. So after that, `update catalogue set item_code = …` cascades
-- to every FK child automatically.
--
-- The only remaining copies are the NON-FK, customer-facing `item_code_raw` cells (the original
-- as-shown code) on order_lines / inbound / purchase_orders / outbound_shipments — the function fixes
-- the ones that exactly matched the old code. The Inventory `stock_snapshot` matview (0019/0051) is a
-- deferred read model that self-heals on its next Refresh; the live stock_check view reflects the
-- rename instantly, so no forced refresh is coupled in here.
--
-- Idempotent: FK drop-by-lookup + re-add, function create-or-replace, repeatable revoke/grant.
-- Verify after applying:
--   select public.rename_sku('__nope__','x');   -- errors: source not found (function exists, guards work)

begin;

-- ── part 1: sku_images FK gains ON UPDATE CASCADE (drop whatever it's currently named, re-add canon) ──
do $$
declare cn text;
begin
  select conname into cn
  from pg_constraint
  where conrelid = 'public.sku_images'::regclass
    and contype = 'f'
    and confrelid = 'public.catalogue'::regclass;
  if cn is not null then
    execute format('alter table public.sku_images drop constraint %I', cn);
  end if;
end $$;

alter table public.sku_images
  add constraint sku_images_item_code_fkey
  foreign key (item_code) references public.catalogue(item_code)
  on update cascade on delete cascade;

-- ── part 2: rename_sku(old, new) — one atomic re-key ──
create or replace function public.rename_sku(p_old text, p_new text)
returns void
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_old text := btrim(p_old);
  v_new text := btrim(p_new);
begin
  -- gate: SECURITY DEFINER bypasses RLS, so re-assert the app's allow-list on the caller's JWT.
  if not public.is_allowed_user() then
    raise exception 'rename_sku: not authorized';
  end if;
  if v_old = '' or v_new = '' then
    raise exception 'rename_sku: both the current and new codes are required';
  end if;
  if v_old = v_new then
    return;  -- no-op
  end if;
  if not exists (select 1 from catalogue where item_code = v_old) then
    raise exception 'rename_sku: source SKU % not found', v_old;
  end if;
  if exists (select 1 from catalogue where item_code = v_new) then
    raise exception 'rename_sku: target code % already exists', v_new;
  end if;

  -- re-key the catalogue row; all FK children with ON UPDATE CASCADE follow automatically.
  update catalogue set item_code = v_new, updated_at = now() where item_code = v_old;

  -- non-FK, customer-facing raw copies of the code: fix ONLY the exact old-code matches (a legitimately
  -- different original cell — an unresolved TEMP/Bonus sentinel — must be left untouched).
  update order_lines        set item_code_raw = v_new where item_code_raw = v_old;
  update inbound            set item_code_raw = v_new where item_code_raw = v_old;
  update purchase_orders    set item_code_raw = v_new where item_code_raw = v_old;
  update outbound_shipments set item_code_raw = v_new where item_code_raw = v_old;
end
$func$;

revoke all on function public.rename_sku(text, text) from public, anon;
grant execute on function public.rename_sku(text, text) to authenticated, service_role;

commit;
