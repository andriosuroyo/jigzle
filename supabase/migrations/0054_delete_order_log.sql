-- PR148 — delete an order at ANY stage (Pending → Fulfill → Outbound → History), with an audit log.
--   1. order_delete_log — one row per deletion: who, when, and a full jsonb snapshot (order + lines +
--      payments + shipments + boxes) so an accidental delete can be reconstructed by hand.
--   2. delete_order(p_sales_id) — the general hard delete, one transaction:
--        • snapshot into order_delete_log (stamped with the signed-in email)
--        • compensating stock adjustments for SHIPPED units — the 0009 stock_check view counts
--          Σ shipped from order_lines, so deleting a shipped line would phantom-restore stock for
--          units that physically left the shelf; a −qty adjustment per item_code cancels that out.
--          Cut-but-unshipped lines restore stock by deletion alone (they were only reserved) — correct.
--        • delete boxes (by the order's send_ids) → outbound_shipments (its sales_id FK is NO ACTION,
--          so it must go before orders) → payments → order_lines → orders (the last two cascade
--          anyway, 0005 — explicit for the same belt-and-suspenders reason as 0033).
-- delete_pending_order (0033) remains for the Pending fast path; delete_order is the general one the
-- UI calls behind an overlay confirmation. Same posture as the house style: security invoker +
-- pinned search_path; revoke public/anon, grant authenticated/service_role; RLS (is_allowed_user())
-- gates every underlying read/write.

-- ============== 1. order_delete_log ==============
create table if not exists public.order_delete_log (
  log_id      bigint generated always as identity primary key,
  sales_id    text not null,
  customer_id bigint,
  deleted_by  text,                                -- login email (auth.jwt), stamped by the RPC
  deleted_at  timestamptz not null default now(),
  snapshot    jsonb not null                       -- { order, lines, payments, shipments, boxes }
);
create index if not exists order_delete_log_sales_idx on public.order_delete_log (sales_id);

alter table public.order_delete_log enable row level security;
drop policy if exists "order_delete_log_all" on public.order_delete_log;
create policy "order_delete_log_all" on public.order_delete_log
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());
grant select, insert on public.order_delete_log to authenticated, service_role;

-- ============== 2. delete_order ==============
create or replace function public.delete_order(p_sales_id text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_order    jsonb;
  v_customer bigint;
  v_send_ids text[];
  v_email    text := lower(auth.jwt() ->> 'email');
  v_rec      record;
begin
  select to_jsonb(o), o.customer_id into v_order, v_customer
    from orders o where o.sales_id = p_sales_id;
  if v_order is null then
    raise exception 'delete_order: order % not found', p_sales_id;
  end if;

  -- the order's dispatch groups (boxes hang off send_id; one send_id = one record_shipment call for
  -- this order, never shared across orders)
  select coalesce(array_agg(distinct send_id), '{}'::text[]) into v_send_ids
    from outbound_shipments
   where sales_id = p_sales_id and send_id is not null;

  -- a. audit snapshot FIRST — the log row commits or the whole delete rolls back
  insert into order_delete_log (sales_id, customer_id, deleted_by, snapshot)
  values (
    p_sales_id, v_customer, v_email,
    jsonb_build_object(
      'order',     v_order,
      'lines',     (select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) from order_lines        l where l.sales_id = p_sales_id),
      'payments',  (select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) from payments           p where p.sales_id = p_sales_id),
      'shipments', (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from outbound_shipments s where s.sales_id = p_sales_id),
      'boxes',     (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from boxes              b where b.send_id = any(v_send_ids))
    )
  );

  -- b. compensating adjustments: shipped units left the shelf — keep them off the stock ledger
  for v_rec in
    select item_code, sum(qty)::int as q
      from order_lines
     where sales_id = p_sales_id
       and shipped_at is not null
       and not is_cancelled
       and item_code is not null
     group by item_code
  loop
    insert into adjustments (item_code, delta, source, note, created_by)
    values (v_rec.item_code, -v_rec.q, 'manual',
            'delete_order ' || p_sales_id || ' — keep shipped units off the shelf', v_email);
  end loop;

  -- c. the delete, children first
  delete from boxes              where send_id = any(v_send_ids);
  delete from outbound_shipments where sales_id = p_sales_id;
  delete from payments           where sales_id = p_sales_id;
  delete from order_lines        where sales_id = p_sales_id;
  delete from orders             where sales_id = p_sales_id;
end;
$$;
revoke all on function public.delete_order(text) from public, anon;
grant execute on function public.delete_order(text) to authenticated, service_role;
