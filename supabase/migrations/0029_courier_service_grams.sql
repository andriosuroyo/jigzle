-- PR26 — Fulfill/Outbound pass, backend half. Two additive changes:
--   1. order_lines gains courier_speed + courier_label so Fulfill captures the structured
--      {courier, speed} pair (chosen from the SETTINGS courier-services list) and Outbound can
--      render the denormalized label in its copy block without a join. order_lines.courier stays
--      the base courier name (e.g. 'TIKI'). fulfill_order gains p_courier_speed / p_courier_label.
--   2. record_shipment volumetric weight: /6000.0 (kg) → /6.0 (grams). The box "real" input is in
--      grams, so vol must be grams too for chargeable = greatest(real, vol) to compare like units.
-- Both functions keep `security invoker` + `set search_path = public` (same posture as 0013/0014).

-- ============== 1. order_lines courier service columns ==============
alter table public.order_lines add column if not exists courier_speed text;   -- e.g. 'ONS','YES' (NULL = courier has no speed tier)
alter table public.order_lines add column if not exists courier_label text;    -- e.g. 'TIKI ONS' (denormalized display)

-- fulfill_order: add p_courier_speed / p_courier_label, stamped beside courier / courier_tracking.
-- The arg count changes (5 → 7), so drop the old overload first — otherwise CREATE OR REPLACE would
-- leave a dangling 5-arg function and rpc() by named params would be ambiguous.
drop function if exists public.fulfill_order(text, text[], bigint, text, text);

create or replace function public.fulfill_order(
  p_sales_id      text,
  p_line_ids      text[],
  p_address_id    bigint,
  p_courier       text,
  p_tracking      text,
  p_courier_speed text,
  p_courier_label text
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

  -- a. Stamp fulfilled_at on the selected lines that are still unfulfilled & not cancelled, and set
  --    the chosen address + planned courier/speed/label/tracking. Capture fulfilled qty per item_code.
  with upd as (
    update order_lines
       set fulfilled_at     = now(),
           address_id       = coalesce(p_address_id, address_id),
           courier          = p_courier,
           courier_speed    = p_courier_speed,
           courier_label    = p_courier_label,
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

  -- b. HOLD AUTO-RELEASE (D6), CAPPED at the fulfilled qty per item_code (unchanged from 0013).
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

revoke all on function public.fulfill_order(text, text[], bigint, text, text, text, text) from public, anon;
grant execute on function public.fulfill_order(text, text[], bigint, text, text, text, text) to authenticated, service_role;

-- ============== 2. record_shipment — grams vol fix (/6000.0 → /6.0) ==============
-- Body identical to 0014 EXCEPT the box-insert CTE's vol formula. Same signature → plain replace.
create or replace function public.record_shipment(
  p_sales_id text,
  p_line_ids text[],
  p_courier  text,
  p_tracking text,
  p_boxes    jsonb
) returns text[]
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_cust       bigint;
  v_order_addr bigint;
  v_today      date;
  v_period     text;
  v_seq        int;
  v_send_id    text;
  v_codes      text[] := '{}';
  v_shipped_n  int := 0;
begin
  select customer_id, address_id into v_cust, v_order_addr from orders where sales_id = p_sales_id;

  -- allocate SND-YYMM-#### under an advisory lock (monthly counter; same safety as the JZ ids).
  v_today  := (now() at time zone 'Asia/Jakarta')::date;
  v_period := to_char(v_today, 'YYMM');
  perform pg_advisory_xact_lock(hashtext('jz_send_seq'), hashtext(v_period));
  select coalesce(max(substring(send_id from 10 for 4)::int), 0) + 1 into v_seq
    from outbound_shipments where send_id like 'SND-' || v_period || '-%';
  v_send_id := 'SND-' || v_period || '-' || lpad(v_seq::text, 4, '0');

  -- ship the eligible lines (already fulfilled, not yet shipped, not cancelled) and write one
  -- outbound_shipments row per shipped line. Capture affected codes + count.
  -- PR26 (O4): courier/tracking are set at Fulfill and travel on the line; Outbound no longer sends
  -- them (passes null). COALESCE so a null payload PRESERVES the fulfill-stamped values rather than
  -- wiping them; the outbound_shipments row then takes the line's own courier (what reconciliation reads).
  with shipped as (
    update order_lines
       set shipped_at       = now(),
           courier          = coalesce(p_courier, courier),
           courier_tracking = coalesce(p_tracking, courier_tracking)
     where line_id = any(p_line_ids) and sales_id = p_sales_id
       and fulfilled_at is not null and shipped_at is null and not is_cancelled
    returning line_id, item_code, qty, address_id, courier
  ),
  ins as (
    insert into outbound_shipments
      (sales_id, order_line_id, send_id, customer_id, item_code, qty, ship_date, address, courier)
    select p_sales_id, s.line_id, v_send_id, v_cust, s.item_code, s.qty, v_today, ca.raw_address, s.courier
    from shipped s
    left join customer_addresses ca on ca.address_id = coalesce(s.address_id, v_order_addr)
    returning item_code
  )
  select coalesce(array_agg(distinct item_code) filter (where item_code is not null), '{}'),
         count(*)
    into v_codes, v_shipped_n
  from ins;

  -- nothing eligible was shipped → no boxes, no status flip (the send_id simply goes unused)
  if v_shipped_n = 0 then
    return '{}';
  end if;

  -- boxes for this send. RECOMPUTE vol_weight / chargeable_weight server-side — trust the box's own
  -- real_weight + dims, never any client-sent chargeable. vol = ceil·ceil·ceil/6 (GRAMS — PR26 fix,
  -- was /6000); chargeable = max(real, vol) via GREATEST (which ignores NULLs, so a box with no dims
  -- bills by real and a box with no real bills by vol). bill_by_volume kept (defaults false) but is
  -- cosmetic — chargeable is always the larger.
  if p_boxes is not null and jsonb_typeof(p_boxes) = 'array' then
    insert into boxes (send_id, real_weight, dim_p, dim_l, dim_t, bill_by_volume, vol_weight, chargeable_weight)
    select v_send_id, b.real_weight, b.dim_p, b.dim_l, b.dim_t, b.bill_by_volume,
           b.vol, greatest(b.real_weight, b.vol)
    from (
      select (j->>'real_weight')::numeric as real_weight,
             (j->>'dim_p')::numeric       as dim_p,
             (j->>'dim_l')::numeric       as dim_l,
             (j->>'dim_t')::numeric       as dim_t,
             coalesce((j->>'bill_by_volume')::boolean, false) as bill_by_volume,
             case when (j->>'dim_p') is not null and (j->>'dim_l') is not null and (j->>'dim_t') is not null
                  then ceil((j->>'dim_p')::numeric) * ceil((j->>'dim_l')::numeric) * ceil((j->>'dim_t')::numeric) / 6.0
                  else null end           as vol
      from jsonb_array_elements(p_boxes) as box_in(j)
    ) b;
  end if;

  -- order complete when no unshipped, non-cancelled line remains (independent of payment_status)
  if not exists (
    select 1 from order_lines
     where sales_id = p_sales_id and shipped_at is null and not is_cancelled
  ) then
    update orders set status = 'Complete' where sales_id = p_sales_id;
  end if;

  return v_codes;
end;
$$;

revoke all on function public.record_shipment(text, text[], text, text, jsonb) from public, anon;
grant execute on function public.record_shipment(text, text[], text, text, jsonb) to authenticated, service_role;
