-- apply-0013.sql
-- Paste-ready bundle for the Supabase SQL editor. Adds the Fulfill module's fulfill_order()
-- RPC (Sales pipeline step 4). SQL is identical to supabase/migrations/0013_fulfill.sql; only
-- this banner is added. Additive — one function, NO DDL changes (D1 is timestamp-driven, so
-- orders.status and its CHECK are untouched). It does not touch existing rows, the stock_check
-- view, the create_order RPC, or the importer. Run it once.

-- ============================================================================
-- 0013_fulfill.sql
-- ============================================================================

create or replace function public.fulfill_order(
  p_sales_id   text,
  p_line_ids   text[],
  p_address_id bigint,
  p_courier    text,
  p_tracking   text
) returns text[]
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cust   bigint;
  v_ff     jsonb := '{}'::jsonb;   -- {item_code: total fulfilled qty} for this call
  v_codes  text[];
  v_code   text;
  v_budget int;
  v_hold   record;
begin
  select customer_id into v_cust from orders where sales_id = p_sales_id;

  -- a. Stamp fulfilled_at on the selected lines that are still unfulfilled & not cancelled,
  --    and set the chosen address + planned courier/tracking. Capture fulfilled qty per
  --    item_code (a data-modifying CTE so the UPDATE runs exactly once).
  with upd as (
    update order_lines
       set fulfilled_at     = now(),
           address_id       = coalesce(p_address_id, address_id),
           courier          = p_courier,
           courier_tracking = p_tracking
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

  -- b. HOLD AUTO-RELEASE (D6), CAPPED at the fulfilled qty per item_code.
  --    INVARIANT: for each item_code, Σ released_hold_qty ≤ Σ fulfilled_qty (this call).
  --    A hold and a fulfilled line reserve the SAME physical unit. Fulfilling lowers
  --    available by the fulfilled qty (the `fulfilled` term in stock_check); releasing a
  --    hold raises available by the hold qty (drops the `holds` term). To avoid a double
  --    count we must release AT MOST what we just fulfilled — never more — so a held unit
  --    being fulfilled nets to zero available change, while an unheld unit drops available
  --    by 1. We release whole hold rows oldest-first, taking each only while it still fits
  --    the remaining budget (so cumulative released ≤ fulfilled; a hold larger than the
  --    remaining budget is left active). Only holds for this order's customer — or
  --    customer-agnostic holds (customer_id is null) — are eligible.
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
      -- a hold bigger than the remaining budget is skipped (left active), oldest-first
    end loop;
  end loop;

  -- c. Return the affected item_codes so the client re-reads stock_check for those SKUs.
  select array(select jsonb_object_keys(v_ff)) into v_codes;
  return v_codes;
end;
$$;

revoke all on function public.fulfill_order(text, text[], bigint, text, text) from public, anon;
grant execute on function public.fulfill_order(text, text[], bigint, text, text) to authenticated, service_role;
