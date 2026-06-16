-- Phase 1 — truncate helper for the re-runnable importer (2026-06-16).
-- The importer does a FULL CLEAN LOAD (Decision D7). PostgREST cannot issue TRUNCATE,
-- and deleting the large parent tables row-by-row blows the role statement_timeout
-- (per-row FK-integrity checks on catalogue). This SECURITY DEFINER function does a
-- single TRUNCATE … RESTART IDENTITY CASCADE — instant, resets surrogate ids, and
-- cascades to dependents (e.g. boxes). It runs as the function owner (postgres, from
-- the SQL editor), which owns the tables, so it has TRUNCATE rights.
--
-- Locked down: only service_role (the importer's key) may execute it — never anon
-- or authenticated.
create or replace function public.truncate_phase1_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  truncate table
    public.royalty_paid, public.outbound_shipments, public.missing_pieces,
    public.purchase_orders, public.inbound, public.payments, public.order_lines,
    public.holds, public.orders, public.shipments, public.forwarders,
    public.customer_addresses, public.sku_sources, public.barcodes,
    public.customers, public.catalogue, public.suppliers, public.brands
  restart identity cascade;
end;
$$;

revoke all on function public.truncate_phase1_data() from public, anon, authenticated;
grant execute on function public.truncate_phase1_data() to service_role;
