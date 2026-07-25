-- PR404 — New order can take an item the catalogue doesn't carry yet (a CUSTOM line). Such a line is
-- stored the way legacy imported lines and Purchasing's manual To-buy items already are (PR231): NO
-- item_code FK, the operator's typed name in the non-FK `item_code_raw` placeholder, matched to a real
-- SKU later (when the goods arrive). order_lines.item_code_raw exists since 0005 — the only gap was
-- create_order, which never wrote it, so a custom line's name had nowhere to live.
--
-- This is create_order EXACTLY as 0033 left it (relaxed null address, SA-1), plus one column in the
-- per-line INSERT: item_code_raw = nullif(l->>'item_code_raw',''). Same signature → the existing grants
-- persist; security invoker + pinned search_path (house style), and RLS (is_allowed_user()) still gates
-- every write. Idempotent (create or replace) — safe to re-run.
--
-- Until this is applied, submitOrder patches item_code_raw onto the freshly-created custom lines itself
-- (a plain UPDATE), so the app degrades gracefully; afterwards that patch simply finds nothing to do.

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
    insert into order_lines (line_id, sales_id, item_code, item_code_raw, qty, unit_price_idr,
                             item_link, line_note, fulfilled_at, shipped_at, is_cancelled, address_id)
    values (v_sales_id || '-' || v_n,
            v_sales_id,
            nullif(v_line->>'item_code', ''),
            nullif(v_line->>'item_code_raw', ''),   -- PR404: custom (non-catalogue) item name
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
