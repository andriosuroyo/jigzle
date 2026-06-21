-- PR-B — Sales pipeline cutover, the one migration. ADDITIVE: one function, no DDL.
-- delete_pending_order is the hard delete behind Pending's "Delete pending" link (§3 FP-4): an order
-- that is still FULLY uncut (no line fulfilled or shipped) can be erased outright — payments + lines +
-- order in one transaction. GUARD: refuse if ANY line is cut (fulfilled_at) or shipped (shipped_at) —
-- such an order is partly in Fulfill/Outbound and must be unwound there, never hard-deleted.
--   payments.sales_id and order_lines.sales_id both FK orders(sales_id) ON DELETE CASCADE (0005), so
--   the delete from orders alone would cascade; the explicit child deletes are belt-and-suspenders and
--   make the intent + transaction boundary obvious. holds are NOT order-owned → never touched here.
-- Same posture as 0032: security invoker + set search_path = public; revoke public/anon + grant
-- authenticated/service_role.
create or replace function public.delete_pending_order(p_sales_id text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cut int;
begin
  -- guard: refuse if ANY line is cut or shipped (order is not fully pending)
  select count(*) into v_cut
    from order_lines
   where sales_id = p_sales_id
     and (fulfilled_at is not null or shipped_at is not null);
  if v_cut > 0 then
    raise exception 'delete_pending_order: order % has % cut/shipped line(s); refusing hard delete',
      p_sales_id, v_cut;
  end if;

  delete from payments    where sales_id = p_sales_id;   -- payments.sales_id → orders(sales_id) (0005)
  delete from order_lines where sales_id = p_sales_id;
  delete from orders      where sales_id = p_sales_id;
end;
$$;
revoke all on function public.delete_pending_order(text) from public, anon;
grant execute on function public.delete_pending_order(text) to authenticated, service_role;
