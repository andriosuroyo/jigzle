-- apply-0011.sql
-- Paste-ready bundle for the Supabase SQL editor. Creates the truncate helper the
-- importer calls for its full clean load. SQL is identical to
-- supabase/migrations/0011_truncate_fn.sql; only this banner is added. Run it once
-- (before the next --execute).

-- ============================================================================
-- 0011_truncate_fn.sql
-- ============================================================================

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
