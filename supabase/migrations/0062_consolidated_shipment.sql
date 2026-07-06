-- PR197 — Consolidated shipment: ship several orders that go to the SAME customer + address + courier
-- as ONE send (one box group, one parcel), even though they are separate sales_ids. The schema already
-- allows this — outbound_shipments carries sales_id PER ROW and boxes group by send_id — so the only
-- blockers were code that assumed "one send_id = one order". This migration:
--   1. record_consolidated_shipment — a generalization of record_shipment (0035) across orders: one
--      send_id, one box set, shipped_at stamped on every eligible line, each order flipped to Complete
--      when it has no unshipped line left. Guards that every line shares customer_id + address + courier.
--   2. cancel_shipment — SUPERSEDES 0060: un-record a send that may now span multiple orders (null
--      shipped_at on ALL its lines, flip EACH affected order back to Need send).
--   3. delete_order — SUPERSEDES 0054: only delete boxes for send_ids used EXCLUSIVELY by this order;
--      a send shared with surviving orders keeps its boxes (this order's outbound rows still go).
-- Both rewrites are exact supersets: with no shared send (every send today), they behave identically to
-- 0060 / 0054. House posture throughout: security invoker + pinned search_path; revoke public/anon,
-- grant authenticated/service_role; RLS (is_allowed_user()) gates the underlying reads/writes.

-- ============== 1. record_consolidated_shipment ==============
create or replace function public.record_consolidated_shipment(
  p_line_ids text[],
  p_boxes    jsonb,
  p_verify   jsonb default '[]'::jsonb,
  p_staff    text  default null
) returns text[]
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_today     date;
  v_period    text;
  v_seq       int;
  v_send_id   text;
  v_codes     text[] := '{}';
  v_shipped_n int := 0;
  v_n         int;
  v_cust_n    int;
  v_addr_n    int;
  v_cour_n    int;
begin
  -- consistency guards over the ELIGIBLE lines (fulfilled, unshipped, not cancelled). A consolidated
  -- send is one parcel → it must be one customer, one destination address, one courier. address is the
  -- line's own (set at fulfill) falling back to the order's; courier is the line's.
  select count(*),
         count(distinct o.customer_id),
         count(distinct coalesce(ol.address_id, o.address_id)),
         count(distinct ol.courier)
    into v_n, v_cust_n, v_addr_n, v_cour_n
  from order_lines ol
  join orders o on o.sales_id = ol.sales_id
  where ol.line_id = any(p_line_ids)
    and ol.fulfilled_at is not null and ol.shipped_at is null and not ol.is_cancelled;

  if v_n = 0 then
    raise exception 'record_consolidated_shipment: no eligible (fulfilled, unshipped) lines';
  end if;
  if v_cust_n > 1 then
    raise exception 'record_consolidated_shipment: lines span different customers — cannot combine';
  end if;
  if v_addr_n > 1 then
    raise exception 'record_consolidated_shipment: lines ship to different addresses — cannot combine';
  end if;
  if v_cour_n > 1 then
    raise exception 'record_consolidated_shipment: lines use different couriers — align them in Fulfill first';
  end if;

  -- allocate ONE SND-YYMM-#### for the whole send (same advisory-lock counter as record_shipment).
  v_today  := (now() at time zone 'Asia/Jakarta')::date;
  v_period := to_char(v_today, 'YYMM');
  perform pg_advisory_xact_lock(hashtext('jz_send_seq'), hashtext(v_period));
  select coalesce(max(substring(send_id from 10 for 4)::int), 0) + 1 into v_seq
    from outbound_shipments where send_id like 'SND-' || v_period || '-%';
  v_send_id := 'SND-' || v_period || '-' || lpad(v_seq::text, 4, '0');

  -- ship every eligible line and write one outbound_shipments row per line — each keeps its OWN sales_id
  -- (so a send legitimately spans orders), all sharing this send_id. courier/note travel on the line;
  -- p_verify (by line_id) stamps how each was checked; p_staff stamps who shipped.
  with shipped as (
    update order_lines ol
       set shipped_at = now()
     where ol.line_id = any(p_line_ids)
       and ol.fulfilled_at is not null and ol.shipped_at is null and not ol.is_cancelled
    returning ol.line_id, ol.sales_id, ol.item_code, ol.qty, ol.line_note, ol.address_id, ol.courier
  ),
  ins as (
    insert into outbound_shipments
      (sales_id, order_line_id, send_id, customer_id, item_code, qty, ship_date, address, courier,
       note, verify_method, scanned_barcode, staff)
    select s.sales_id, s.line_id, v_send_id, o.customer_id, s.item_code, s.qty, v_today, ca.raw_address, s.courier,
           s.line_note,
           v.method,
           case when v.method = 'scan' then v.barcode else null end,
           nullif(p_staff, '')
    from shipped s
    join orders o on o.sales_id = s.sales_id
    left join customer_addresses ca on ca.address_id = coalesce(s.address_id, o.address_id)
    left join jsonb_to_recordset(coalesce(p_verify, '[]'::jsonb))
                as v(line_id text, method text, barcode text) on v.line_id = s.line_id
    returning item_code
  )
  select coalesce(array_agg(distinct item_code) filter (where item_code is not null), '{}'),
         count(*)
    into v_codes, v_shipped_n
  from ins;

  if v_shipped_n = 0 then
    return '{}';
  end if;

  -- boxes for the send (recompute vol / chargeable server-side — identical to record_shipment 0035).
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

  -- flip EACH order in this send to Complete when it has no unshipped, non-cancelled line remaining.
  update orders o set status = 'Complete'
   where o.sales_id in (select distinct sales_id from outbound_shipments where send_id = v_send_id)
     and o.status <> 'Complete'
     and not exists (
       select 1 from order_lines l
        where l.sales_id = o.sales_id and l.shipped_at is null and not l.is_cancelled
     );

  return v_codes;
end;
$$;
revoke all on function public.record_consolidated_shipment(text[], jsonb, jsonb, text) from public, anon;
grant execute on function public.record_consolidated_shipment(text[], jsonb, jsonb, text) to authenticated, service_role;

-- ============== 2. cancel_shipment — send-aware (supersedes 0060) ==============
-- Now a send may span multiple orders. Un-ship ALL of the send's lines, delete its boxes + outbound
-- rows, and flip EACH affected order Complete → Need send. No compensating adjustment (nothing left the
-- shelf). Identical to 0060 when the send belongs to a single order.
create or replace function public.cancel_shipment(p_send_id text)
returns text[]
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_line_ids  text[];
  v_sales_ids text[];
  v_codes     text[] := '{}';
  v_email     text := lower(auth.jwt() ->> 'email');
begin
  select array_agg(distinct order_line_id) filter (where order_line_id is not null),
         array_agg(distinct sales_id)      filter (where sales_id is not null)
    into v_line_ids, v_sales_ids
    from outbound_shipments
   where send_id = p_send_id;

  if v_sales_ids is null or array_length(v_sales_ids, 1) is null then
    raise exception 'cancel_shipment: send % not found (legacy/CSV rows carry no send_id and cannot be cancelled)', p_send_id;
  end if;

  -- a. audit snapshot FIRST
  insert into shipment_cancel_log (send_id, sales_id, cancelled_by, snapshot)
  values (
    p_send_id, array_to_string(v_sales_ids, ','), v_email,
    jsonb_build_object(
      'shipments', (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from outbound_shipments s where s.send_id = p_send_id),
      'boxes',     (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from boxes              b where b.send_id = p_send_id)
    )
  );

  -- b. un-ship every line in the send (across all its orders); no stock adjustment — nothing left.
  with un as (
    update order_lines
       set shipped_at = null
     where line_id = any(v_line_ids)
       and shipped_at is not null
    returning item_code
  )
  select coalesce(array_agg(distinct item_code) filter (where item_code is not null), '{}')
    into v_codes
  from un;

  -- c. drop the send's boxes + outbound rows (a re-ship rewrites them under a fresh send_id)
  delete from boxes              where send_id = p_send_id;
  delete from outbound_shipments where send_id = p_send_id;

  -- d. each order that had gone Complete now has an unshipped line → back to Need send.
  update orders set status = 'Need send'
   where sales_id = any(v_sales_ids) and status = 'Complete';

  return v_codes;
end;
$$;
revoke all on function public.cancel_shipment(text) from public, anon;
grant execute on function public.cancel_shipment(text) to authenticated, service_role;

-- ============== 3. delete_order — shared-send-aware (supersedes 0054) ==============
-- Only delete boxes for send_ids used EXCLUSIVELY by this order. A send shared with other (surviving)
-- orders keeps its boxes; deleting this order's outbound rows (by sales_id) still leaves the siblings'
-- rows intact. Everything else (audit snapshot, compensating adjustments for shipped units, cascade
-- delete) is unchanged. Identical to 0054 when no send is shared.
create or replace function public.delete_order(p_sales_id text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_order         jsonb;
  v_customer      bigint;
  v_all_send_ids  text[];
  v_excl_send_ids text[];
  v_email         text := lower(auth.jwt() ->> 'email');
  v_rec           record;
begin
  select to_jsonb(o), o.customer_id into v_order, v_customer
    from orders o where o.sales_id = p_sales_id;
  if v_order is null then
    raise exception 'delete_order: order % not found', p_sales_id;
  end if;

  -- every send this order participated in (for the audit snapshot)
  select coalesce(array_agg(distinct send_id), '{}'::text[]) into v_all_send_ids
    from outbound_shipments
   where sales_id = p_sales_id and send_id is not null;

  -- sends used ONLY by this order → safe to delete their boxes. A send shared with another order keeps
  -- its boxes (the surviving order still needs them).
  select coalesce(array_agg(s), '{}'::text[]) into v_excl_send_ids
  from (
    select distinct o.send_id as s
    from outbound_shipments o
    where o.sales_id = p_sales_id and o.send_id is not null
      and not exists (
        select 1 from outbound_shipments o2
        where o2.send_id = o.send_id and o2.sales_id <> p_sales_id
      )
  ) t;

  -- a. audit snapshot FIRST — the log row commits or the whole delete rolls back
  insert into order_delete_log (sales_id, customer_id, deleted_by, snapshot)
  values (
    p_sales_id, v_customer, v_email,
    jsonb_build_object(
      'order',     v_order,
      'lines',     (select coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) from order_lines        l where l.sales_id = p_sales_id),
      'payments',  (select coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb) from payments           p where p.sales_id = p_sales_id),
      'shipments', (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from outbound_shipments s where s.sales_id = p_sales_id),
      'boxes',     (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from boxes              b where b.send_id = any(v_all_send_ids))
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

  -- c. the delete, children first. Boxes: only sends EXCLUSIVE to this order (shared sends survive).
  delete from boxes              where send_id = any(v_excl_send_ids);
  delete from outbound_shipments where sales_id = p_sales_id;
  delete from payments           where sales_id = p_sales_id;
  delete from order_lines        where sales_id = p_sales_id;
  delete from orders             where sales_id = p_sales_id;
end;
$$;
revoke all on function public.delete_order(text) from public, anon;
grant execute on function public.delete_order(text) to authenticated, service_role;
