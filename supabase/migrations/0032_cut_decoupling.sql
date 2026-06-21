-- PR-A — Stock-cut decoupling, backend half. ADDITIVE, non-breaking: two NEW functions, no DDL.
-- Today fulfill_order (0029) stamps fulfilled_at AND sets courier/address in one UPDATE. The sales
-- redesign needs the cut (available → reserved, driven by fulfilled_at) to happen with NO
-- courier/address, so those can be set later in Fulfill. This splits the engine in two:
--   1. cut_order_lines    — fulfilled_at only (the cut + hold auto-release), no courier/address.
--   2. set_fulfillment    — courier/address on already-cut lines, no stock movement, no hold logic.
-- fulfill_order, record_shipment, unfulfill_order are LEFT UNTOUCHED so the current Fulfill UI keeps
-- working until PR-B rewires it. Nothing calls the two new RPCs yet (the smoke is their only consumer
-- this PR) → no breakage window. Both keep `security invoker` + `set search_path = public` (same
-- posture as 0029). Same revoke/grant block as 0029.

-- ============== 1. cut_order_lines — cut only, no courier/address ==============
-- Body = fulfill_order's logic with the UPDATE reduced to fulfilled_at only. Hold auto-release (b)
-- and the affected-codes return (c) are IDENTICAL to fulfill_order (copied verbatim so behaviour
-- matches). Permissive: no negative-stock block (the UI gates it, same as fulfill_order today).
create or replace function public.cut_order_lines(
  p_sales_id text,
  p_line_ids text[]
) returns text[]
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cust   bigint;
  v_ff     jsonb := '{}'::jsonb;   -- {item_code: total cut qty} for this call
  v_codes  text[];
  v_code   text;
  v_budget int;
  v_hold   record;
begin
  select customer_id into v_cust from orders where sales_id = p_sales_id;

  -- a. Stamp fulfilled_at on the selected lines still unfulfilled & not cancelled — NO courier/address.
  --    Capture cut qty per item_code (a data-modifying CTE so the UPDATE runs exactly once).
  with upd as (
    update order_lines
       set fulfilled_at = now()
     where line_id = any(p_line_ids)
       and sales_id = p_sales_id
       and fulfilled_at is null
       and not is_cancelled
    returning item_code, qty
  )
  select coalesce(jsonb_object_agg(item_code, ff_qty), '{}'::jsonb)
    into v_ff
  from (
    select item_code, sum(qty)::int as ff_qty
    from upd
    where item_code is not null
    group by item_code
  ) s;

  -- b. HOLD AUTO-RELEASE, capped at the cut qty per item_code, oldest-first (identical to fulfill_order).
  for v_code, v_budget in select key, value::int from jsonb_each_text(v_ff)
  loop
    for v_hold in
      select hold_id, qty
        from holds
       where item_code = v_code
         and released_at is null
         and (customer_id is null or customer_id = v_cust)
       order by created_at asc, hold_id asc
    loop
      exit when v_budget <= 0;
      if v_hold.qty <= v_budget then
        update holds set released_at = now() where hold_id = v_hold.hold_id;
        v_budget := v_budget - v_hold.qty;
      end if;
    end loop;
  end loop;

  -- c. Return the affected item_codes so the client re-reads stock_check for those SKUs.
  select array(select jsonb_object_keys(v_ff)) into v_codes;
  return v_codes;
end;
$$;
revoke all on function public.cut_order_lines(text, text[]) from public, anon;
grant execute on function public.cut_order_lines(text, text[]) to authenticated, service_role;

-- ============== 2. set_fulfillment — courier/address on already-cut lines, no stock move ==============
-- Arg order mirrors fulfill_order (address, courier, tracking, speed, label). Updates ONLY cut
-- (fulfilled_at is not null), non-cancelled lines. No hold logic, no stock movement (the stock cut
-- already happened in cut_order_lines; this is the Fulfill courier-pick + late-address step, D7).
create or replace function public.set_fulfillment(
  p_sales_id      text,
  p_line_ids      text[],
  p_address_id    bigint,
  p_courier       text,
  p_tracking      text,
  p_courier_speed text,
  p_courier_label text
) returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update order_lines
     set address_id       = coalesce(p_address_id, address_id),
         courier          = p_courier,
         courier_speed    = p_courier_speed,
         courier_label    = p_courier_label,
         courier_tracking = p_tracking
   where line_id = any(p_line_ids)
     and sales_id = p_sales_id
     and fulfilled_at is not null
     and not is_cancelled;
end;
$$;
revoke all on function public.set_fulfillment(text, text[], bigint, text, text, text, text) from public, anon;
grant execute on function public.set_fulfillment(text, text[], bigint, text, text, text, text) to authenticated, service_role;
