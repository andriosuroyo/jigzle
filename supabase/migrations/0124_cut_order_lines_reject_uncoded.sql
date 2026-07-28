-- PR405 — cut_order_lines refuses an UNCODED line.
--
-- Background. A line with item_code NULL has no stock record at all: it is either a PR404 "custom item"
-- (something the catalogue doesn't carry yet) or a legacy import. Pending's lineStatus used to stamp such
-- a line 'available', so it read green and armed "Send to fulfill" — and this RPC would happily stamp
-- fulfilled_at on it, because its stock/hold bookkeeping is already scoped to `item_code is not null`
-- (see 0032). The result: goods nobody had bought were cut into Fulfill with no stock moved and nothing
-- telling Purchasing to buy them. The app-side fix is Pending's status; this is the backstop, so the same
-- mistake can't be made through any other caller.
--
-- Body is 0032's cut_order_lines VERBATIM plus guard (0). Same posture as 0032: security invoker,
-- set search_path = public, same revoke/grant. Idempotent (create or replace).
--
-- The other caller, submitOrder (sales/actions.ts), already excludes uncoded lines from its cut, so this
-- guard changes no working path — it only turns a silent wrong cut into a clear error.

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
  v_uncoded text;
begin
  -- 0. PR405 GUARD: refuse the whole call if any line being cut has no SKU. Such a line has no stock to
  --    move, so cutting it would silently pretend un-bought goods were ready to pack. It must be bought
  --    first (it shows in Purchasing → To buy → From Sales) and matched to a real SKU at Inbound receive.
  select string_agg(coalesce(item_code_raw, line_id), ', ' order by line_id)
    into v_uncoded
  from order_lines
  where line_id = any(p_line_ids)
    and sales_id = p_sales_id
    and fulfilled_at is null
    and not is_cancelled
    and item_code is null;
  if v_uncoded is not null then
    raise exception 'Not in the catalogue yet, so it can''t be sent to Fulfill: %. Buy it first (Purchasing → To buy), then match it to a SKU at Inbound.', v_uncoded
      using errcode = 'check_violation';
  end if;

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
