-- Phase 1 — Sales order-entry module (J2.1). ADDITIVE ONLY.
-- Two schema changes (Decisions D4, D5) + the create_order write function.
-- Does NOT touch existing rows, the stock_check view, or the importer.
--   D4: order_lines.unit_price_idr — manual per-line price (full IDR).
--   D5: extend orders.payment_status CHECK to allow 'Partial' (DP orders).
-- The create_order() function is the single transactional write path used by the
-- ops app's server action: it allocates the JZ-YYMM-#### sales_id under an advisory
-- lock (safe regardless of the single-operator assumption) and inserts the order,
-- its lines, and an optional payment atomically. SECURITY INVOKER so the caller's
-- RLS (is_allowed_user()) applies — the app calls it with the anon key + the user's
-- session, never the service-role key.

-- ============== D4: per-line manual price ==============
alter table public.order_lines
  add column if not exists unit_price_idr bigint;   -- full IDR; orders.sales_total_idr = Σ(qty × unit_price_idr)

-- ============== D5: allow 'Partial' payment status ==============
-- The original constraint (0005) is the inline column check 'orders_payment_status_check'.
-- Drop + re-add with 'Partial' added. Additive for data: Paid/Unpaid/Cancel rows still pass.
alter table public.orders
  drop constraint if exists orders_payment_status_check;
alter table public.orders
  add constraint orders_payment_status_check
  check (payment_status in ('Paid', 'Unpaid', 'Partial', 'Cancel'));

-- ============== create_order(): the transactional write ==============
create or replace function public.create_order(payload jsonb)
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_customer_id bigint := nullif(payload->>'customer_id', '')::bigint;
  v_address_id  bigint := nullif(payload->>'address_id', '')::bigint;
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
  if v_address_id is null then
    raise exception 'create_order: address_id is required';
  end if;

  -- order total = Σ(qty × unit_price)
  select coalesce(sum((l->>'qty')::int * (l->>'unit_price_idr')::bigint), 0)
    into v_total
  from jsonb_array_elements(v_lines) as l;

  v_paid   := coalesce(nullif(v_payment->>'amount_idr', '')::bigint, 0);
  v_method := nullif(v_payment->>'method', '');

  -- D5 save mapping
  if v_total > 0 and v_paid >= v_total then
    v_pay_status := 'Paid';    v_status := 'Need send';
  elsif v_paid > 0 then
    v_pay_status := 'Partial'; v_status := 'Need payment';
  else
    v_pay_status := 'Unpaid';  v_status := 'Need payment';
  end if;

  -- safe sales_id allocation: advisory lock per YYMM period, then max()+1 under the lock
  v_order_date := (now() at time zone 'Asia/Jakarta')::date;
  v_period     := to_char(v_order_date, 'YYMM');
  perform pg_advisory_xact_lock(hashtext('jz_sales_seq'), hashtext(v_period));
  select coalesce(max(substring(sales_id from 9 for 4)::int), 0) + 1
    into v_seq
  from orders
  where sales_id like 'JZ-' || v_period || '-%';
  v_sales_id := 'JZ-' || v_period || '-' || lpad(v_seq::text, 4, '0');

  insert into orders (sales_id, customer_id, address_id, order_date, status,
                      sales_total_idr, payment_method, payment_status, order_note)
  values (v_sales_id, v_customer_id, v_address_id, v_order_date, v_status,
          v_total, v_method, v_pay_status, v_note);

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
            null, null,           -- fulfilled_at / shipped_at: NO stock cut at order entry (D2)
            false,
            v_address_id);
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

-- The ops app calls create_order as the signed-in user (role 'authenticated').
-- anon (pre-login) and public get nothing; RLS on the base tables still gates the writes.
-- service_role (backend/admin, e.g. the importer or a smoke harness) may also call it.
revoke all on function public.create_order(jsonb) from public, anon;
grant execute on function public.create_order(jsonb) to authenticated, service_role;
