-- PR196 — Editable pending orders: add / remove / change a line WITHOUT deleting the whole order, with
-- the sale total and payment status kept honest. The gap: create_order (0033/0030) computes
-- sales_total_idr ONCE and there is no line-level write beyond setLineNote (0035) — so a swap or a
-- quantity fix meant delete_order + re-create. This adds three focused line ops, all scoped to lines
-- that are still in Pending (UNCUT: fulfilled_at IS NULL, unshipped, not cancelled). Because an uncut
-- line has never reserved stock (stock_check counts only fulfilled/shipped rows, 0022), these edits move
-- NO inventory — they only reshape the order and re-derive its money. Cut/shipped lines are out of scope
-- (reverse them first: cancel_shipment 0060 → returnToFulfill 0026 → sendBackToPending 0030).
--
-- All four functions: security invoker + pinned search_path (house style); revoke public/anon, grant
-- authenticated/service_role; RLS (is_allowed_user()) gates every underlying read/write.
--   • recompute_order_payment(p_sales_id) — internal: sales_total_idr = Σ(qty×unit_price) over
--       non-cancelled lines; re-derive payment_status/status from the UNCHANGED paid_idr, using the
--       SAME mapping as create_order / mark_order_paid (Paid→Need send, else Need payment). Only remaps
--       an order still in an editable status ('Need payment' | 'Need send') — never touches Complete/Cancelled.
--   • add_order_line   — append an uncut line (fresh {sales_id}-{n}), then recompute. Adding value to a
--       paid order correctly drops it back to Need payment for the new balance.
--   • update_order_line — change qty and/or unit_price of an uncut line, then recompute.
--   • delete_order_line — hard-remove an uncut line (safe: no outbound_shipments FK on uncut lines),
--       then recompute. Refuses the LAST active line — emptying an order is Delete order (0054), which
--       logs + handles payments; this keeps line-edit from silently creating an empty, unpaid-credit order.

-- ============== 0. recompute helper ==============
create or replace function public.recompute_order_payment(p_sales_id text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_total      bigint;
  v_paid       bigint;
  v_pay_status text;
  v_status     text;
begin
  select coalesce(sum(qty * coalesce(unit_price_idr, 0)) filter (where not is_cancelled), 0)
    into v_total
  from order_lines where sales_id = p_sales_id;

  select coalesce(paid_idr, 0) into v_paid from orders where sales_id = p_sales_id;

  -- SAME mapping as create_order (0030): a fully-paid order is Need send; anything owing is Need payment.
  if v_total > 0 and v_paid >= v_total then
    v_pay_status := 'Paid';    v_status := 'Need send';
  elsif v_paid > 0 then
    v_pay_status := 'Partial'; v_status := 'Need payment';
  else
    v_pay_status := 'Unpaid';  v_status := 'Need payment';
  end if;

  -- the total always reflects the current basket; the payment_status/status remap is confined to orders
  -- still in an editable state, so a partially-shipped/Complete order (not reachable via these ops) is safe.
  update orders set sales_total_idr = v_total where sales_id = p_sales_id;
  update orders
     set payment_status = v_pay_status,
         status         = v_status
   where sales_id = p_sales_id
     and status in ('Need payment', 'Need send');
end;
$$;
revoke all on function public.recompute_order_payment(text) from public, anon;
grant execute on function public.recompute_order_payment(text) to authenticated, service_role;

-- ============== 1. add_order_line ==============
create or replace function public.add_order_line(
  p_sales_id     text,
  p_item_code    text,
  p_qty          int,
  p_unit_price   bigint,
  p_line_note    text default null
) returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status  text;
  v_addr    bigint;
  v_seq     int;
  v_line_id text;
begin
  select status, address_id into v_status, v_addr from orders where sales_id = p_sales_id;
  if not found then
    raise exception 'add_order_line: order % not found', p_sales_id;
  end if;
  if v_status not in ('Need payment', 'Need send') then
    raise exception 'add_order_line: order % is % — only a pending order can gain items', p_sales_id, v_status;
  end if;
  if coalesce(p_qty, 0) < 1 then
    raise exception 'add_order_line: qty must be at least 1';
  end if;

  -- next line suffix = max existing + 1 (never a bare count — a removed line must not be reused). The
  -- suffix is the tail after '{sales_id}-'.
  select coalesce(max((substring(line_id from length(p_sales_id) + 2))::int), 0) + 1
    into v_seq
  from order_lines where sales_id = p_sales_id;
  v_line_id := p_sales_id || '-' || v_seq;

  insert into order_lines (line_id, sales_id, item_code, qty, unit_price_idr, line_note,
                           fulfilled_at, shipped_at, is_cancelled, address_id)
  values (v_line_id, p_sales_id, nullif(p_item_code, ''), p_qty, p_unit_price, nullif(p_line_note, ''),
          null, null, false, v_addr);   -- uncut → lands in Pending; address mirrors the order (create_order)

  perform recompute_order_payment(p_sales_id);
  return v_line_id;
end;
$$;
revoke all on function public.add_order_line(text, text, int, bigint, text) from public, anon;
grant execute on function public.add_order_line(text, text, int, bigint, text) to authenticated, service_role;

-- ============== 2. update_order_line ==============
create or replace function public.update_order_line(
  p_line_id    text,
  p_qty        int,
  p_unit_price bigint
) returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_sales_id text;
begin
  -- only an uncut, unshipped, non-cancelled line (i.e. still in Pending) is editable in place
  select sales_id into v_sales_id
    from order_lines
   where line_id = p_line_id
     and fulfilled_at is null and shipped_at is null and not is_cancelled;
  if not found then
    raise exception 'update_order_line: line % is not an editable pending line', p_line_id;
  end if;
  if coalesce(p_qty, 0) < 1 then
    raise exception 'update_order_line: qty must be at least 1';
  end if;

  update order_lines
     set qty            = p_qty,
         unit_price_idr = p_unit_price
   where line_id = p_line_id;

  perform recompute_order_payment(v_sales_id);
end;
$$;
revoke all on function public.update_order_line(text, int, bigint) from public, anon;
grant execute on function public.update_order_line(text, int, bigint) to authenticated, service_role;

-- ============== 3. delete_order_line ==============
create or replace function public.delete_order_line(p_line_id text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_sales_id text;
  v_active   int;
begin
  -- only an uncut, unshipped, non-cancelled line can be removed here (no outbound_shipments FK exists on
  -- an uncut line, so a hard delete is safe; cut/shipped removal is a reverse-then-edit flow)
  select sales_id into v_sales_id
    from order_lines
   where line_id = p_line_id
     and fulfilled_at is null and shipped_at is null and not is_cancelled;
  if not found then
    raise exception 'delete_order_line: line % is not an editable pending line', p_line_id;
  end if;

  -- refuse the last active line — emptying an order is Delete order (0054), which logs it and settles
  -- the payment story; a line-edit must never leave a lingering empty order with paid_idr stranded.
  select count(*) into v_active
    from order_lines where sales_id = v_sales_id and not is_cancelled;
  if v_active <= 1 then
    raise exception 'delete_order_line: cannot remove the only item — use Delete order instead';
  end if;

  delete from order_lines where line_id = p_line_id;

  perform recompute_order_payment(v_sales_id);
end;
$$;
revoke all on function public.delete_order_line(text) from public, anon;
grant execute on function public.delete_order_line(text) to authenticated, service_role;
