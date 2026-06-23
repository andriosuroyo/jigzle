-- PR-B — Sales pipeline cutover, the one migration. ADDITIVE: two functions, no DDL.
--   1. delete_pending_order — the hard delete behind Pending's "Delete pending".
--   2. create_order (RELAXED) — drops ONLY the null-address raise so SA-1 "Confirm address later"
--      can save an order with address_id = null (orders.address_id + order_lines.address_id are both
--      nullable columns — 0005 — so a null insert is valid; only the RPC guard blocked it). Body is
--      otherwise BYTE-IDENTICAL to 0030's create_order; same signature → grants persist. This is the
--      one extra thing 0033 carries beyond the hard-delete (the prompt scoped 0033 to the delete RPC,
--      but SA-1's null-address save is impossible without relaxing this server-side guard — approved
--      deviation 2026-06-21). When v_address_id is null, orders + every line get a null address_id;
--      Fulfill (FT-6) then shows the "needs address" flag and set_fulfillment coalesces the real
--      choice over it.
--
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

-- ============== create_order (RELAXED — null address allowed for SA-1) ==============
-- IDENTICAL to 0030 except the `if v_address_id is null then raise` block is removed. Same signature
-- → existing grants persist; security invoker + set search_path = public.
create or replace function public.create_order(payload jsonb)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_customer_id bigint := nullif(payload->>'customer_id', '')::bigint;
  v_address_id  bigint := nullif(payload->>'address_id', '')::bigint;   -- NULL = SA-1 "confirm address later"
  v_note        text   := nullif(payload->>'order_note', '');
  v_lines       jsonb  := coalesce(payload->'lines', '[]'::jsonb);
  v_payment     jsonb  := payload->'payment';
  v_total       bigint;
  v_paid        bigint;
  v_method      text;
  v_status      text;
  v_pay_status  text;
  v_order_date  date;
  v_period      text;
  v_seq         int;
  v_sales_id    text;
  v_line        jsonb;
  v_n           int := 0;
begin
  if jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) < 1 then
    raise exception 'create_order: at least one order line is required';
  end if;
  -- (0030's `address_id is required` raise removed — SA-1 may defer the address to Fulfill.)

  select coalesce(sum((l->>'qty')::int * (l->>'unit_price_idr')::bigint), 0)
    into v_total
  from jsonb_array_elements(v_lines) as l;

  v_paid   := coalesce(nullif(v_payment->>'amount_idr', '')::bigint, 0);
  v_method := nullif(v_payment->>'method', '');

  if v_total > 0 and v_paid >= v_total then
    v_pay_status := 'Paid';    v_status := 'Need send';
  elsif v_paid > 0 then
    v_pay_status := 'Partial'; v_status := 'Need payment';
  else
    v_pay_status := 'Unpaid';  v_status := 'Need payment';
  end if;

  v_order_date := (now() at time zone 'Asia/Jakarta')::date;
  v_period     := to_char(v_order_date, 'YYMM');
  perform pg_advisory_xact_lock(hashtext('jz_sales_seq'), hashtext(v_period));
  select coalesce(max(substring(sales_id from 9 for 4)::int), 0) + 1
    into v_seq
  from orders
  where sales_id like 'JZ-' || v_period || '-%';
  v_sales_id := 'JZ-' || v_period || '-' || lpad(v_seq::text, 4, '0');

  insert into orders (sales_id, customer_id, address_id, order_date, status,
                      sales_total_idr, paid_idr, payment_method, payment_status, order_note)
  values (v_sales_id, v_customer_id, v_address_id, v_order_date, v_status,
          v_total, v_paid, v_method, v_pay_status, v_note);

  for v_line in select * from jsonb_array_elements(v_lines)
  loop
    v_n := v_n + 1;
    insert into order_lines (line_id, sales_id, item_code, qty, unit_price_idr,
                             item_link, line_note, fulfilled_at, shipped_at, is_cancelled, address_id)
    values (v_sales_id || '-' || v_n,
            v_sales_id,
            nullif(v_line->>'item_code', ''),
            coalesce((v_line->>'qty')::int, 0),
            nullif(v_line->>'unit_price_idr', '')::bigint,
            nullif(v_line->>'item_link', ''),
            nullif(v_line->>'line_note', ''),
            null, null,
            false,
            v_address_id);   -- NULL when address deferred (SA-1)
  end loop;

  if v_paid > 0 then
    insert into payments (sales_id, amount_idr, type, method, paid_date, note)
    values (v_sales_id, v_paid,
            case when v_total > 0 and v_paid >= v_total then 'Full' else 'DP' end,
            v_method, v_order_date, nullif(v_payment->>'note', ''));
  end if;

  return v_sales_id;
end;
$$;
revoke all on function public.create_order(jsonb) from public, anon;
grant execute on function public.create_order(jsonb) to authenticated, service_role;
