-- apply-0014.sql
-- Paste-ready bundle for the Supabase SQL editor. Adds the Outbound (Ship) module: link/group
-- columns on outbound_shipments + boxes (all nullable; the 5,712 legacy rows are untouched) and
-- the record_shipment() RPC. SQL is identical to supabase/migrations/0014_outbound.sql; only this
-- banner is added. Additive — it does not touch existing rows, the stock_check view, create_order,
-- fulfill_order, or the importer. Run it once.

-- ============================================================================
-- 0014_outbound.sql
-- ============================================================================

-- ============== a. link/group columns ==============
alter table public.outbound_shipments
  add column if not exists sales_id      text references public.orders(sales_id),
  add column if not exists order_line_id text references public.order_lines(line_id),
  add column if not exists send_id       text;   -- 'SND-YYMM-####' dispatch group key

alter table public.boxes
  add column if not exists send_id text;          -- new boxes group by send_id; legacy shipment_id FK unused

create index if not exists outbound_shipments_send_idx     on public.outbound_shipments (send_id);
create index if not exists outbound_shipments_sales_id_idx on public.outbound_shipments (sales_id);
create index if not exists boxes_send_idx                  on public.boxes (send_id);

-- ============== b. record_shipment() ==============
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

  -- allocate SND-YYMM-#### under an advisory lock (monthly counter; same safety as the JZ ids —
  -- never a bare max()+1). 'SND-' (4) + 'YYMM' (4) + '-' (1) = 9, so the counter starts at pos 10.
  v_today  := (now() at time zone 'Asia/Jakarta')::date;
  v_period := to_char(v_today, 'YYMM');
  perform pg_advisory_xact_lock(hashtext('jz_send_seq'), hashtext(v_period));
  select coalesce(max(substring(send_id from 10 for 4)::int), 0) + 1 into v_seq
    from outbound_shipments where send_id like 'SND-' || v_period || '-%';
  v_send_id := 'SND-' || v_period || '-' || lpad(v_seq::text, 4, '0');

  -- ship the eligible lines (already fulfilled, not yet shipped, not cancelled) and write one
  -- outbound_shipments row per shipped line (one-row-per-SKU). Capture affected codes + count.
  with shipped as (
    update order_lines
       set shipped_at = now(), courier = p_courier, courier_tracking = p_tracking
     where line_id = any(p_line_ids) and sales_id = p_sales_id
       and fulfilled_at is not null and shipped_at is null and not is_cancelled
    returning line_id, item_code, qty, address_id
  ),
  ins as (
    insert into outbound_shipments
      (sales_id, order_line_id, send_id, customer_id, item_code, qty, ship_date, address, courier)
    select p_sales_id, s.line_id, v_send_id, v_cust, s.item_code, s.qty, v_today, ca.raw_address, p_courier
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

  -- boxes for this send. RECOMPUTE vol_weight / chargeable_weight server-side — trust the box's
  -- own real_weight + dims, never any client-sent chargeable. vol = ceil·ceil·ceil/6000;
  -- chargeable = max(real, vol) via GREATEST (which ignores NULLs, so a box with no dims bills
  -- by real and a box with no real bills by vol).
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
                  then ceil((j->>'dim_p')::numeric) * ceil((j->>'dim_l')::numeric) * ceil((j->>'dim_t')::numeric) / 6000.0
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
