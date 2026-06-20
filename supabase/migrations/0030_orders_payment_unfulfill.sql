-- PR27 — Unified Orders section, backend half. Three additive changes:
--   1. orders.paid_idr — a running paid total (orders had only the payments ledger; create_order
--      computed paid at creation but kept no running column). Backfilled from current state.
--   2. mark_order_paid — advance a Need-payment order by recording a payment; mirrors create_order's
--      payment→status mapping so a fully-paid order flips to Need send (appears in Fulfill).
--   3. unfulfill_order — the inverse of fulfill_order for a whole order (Outbound's Return to Fulfill).
-- Both RPCs: security invoker + set search_path = public (same posture as 0012/0013/0014).

-- ============== 1. paid_idr + backfill ==============
alter table public.orders add column if not exists paid_idr bigint not null default 0;

-- Backfill from current state, idempotent (guarded by paid_idr = 0 so a re-apply never clobbers a
-- value already set here or by mark_order_paid):
--   Paid    → the full order total
--   Partial → the sum of its payments ledger (best-effort; 0 if none)
--   Unpaid/Cancel → 0 (the column default)
update public.orders o
   set paid_idr = coalesce(o.sales_total_idr, 0)
 where o.payment_status = 'Paid' and o.paid_idr = 0;

update public.orders o
   set paid_idr = coalesce((select sum(p.amount_idr) from public.payments p where p.sales_id = o.sales_id), 0)
 where o.payment_status = 'Partial' and o.paid_idr = 0;

-- ============== 1b. create_order seeds paid_idr ==============
-- create_order (0012) predates paid_idr, so a new DP/Partial order would insert paid_idr=0 (its
-- default) even though a payment was recorded — breaking the paid_idr == Σ payments invariant that
-- mark_order_paid and the Orders board rely on. Redefine it (same signature → grants persist) to
-- stamp paid_idr = v_paid on insert. Body otherwise IDENTICAL to 0012.
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
          v_total, v_paid, v_method, v_pay_status, v_note);   -- PR27: paid_idr = v_paid

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

-- ============== 2. mark_order_paid ==============
create or replace function public.mark_order_paid(
  p_sales_id text,
  p_amount   bigint,
  p_method   text
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_total      bigint;
  v_paid       bigint;
  v_method     text;
  v_status     text;
  v_pay_status text;
  v_today      date;
begin
  select sales_total_idr, paid_idr, payment_method
    into v_total, v_paid, v_method
  from orders where sales_id = p_sales_id;
  if not found then
    raise exception 'mark_order_paid: order % not found', p_sales_id;
  end if;

  v_total  := coalesce(v_total, 0);
  v_paid   := coalesce(v_paid, 0) + coalesce(p_amount, 0);   -- p_amount = the top-up (balance for a full settle)
  v_method := coalesce(nullif(p_method, ''), v_method);

  -- SAME mapping as create_order (0012): a fully-paid order flips to Need send → Fulfill queue.
  if v_total > 0 and v_paid >= v_total then
    v_pay_status := 'Paid';    v_status := 'Need send';
  elsif v_paid > 0 then
    v_pay_status := 'Partial'; v_status := 'Need payment';
  else
    v_pay_status := 'Unpaid';  v_status := 'Need payment';
  end if;

  update orders
     set paid_idr       = v_paid,
         payment_method = v_method,
         payment_status = v_pay_status,
         status         = v_status
   where sales_id = p_sales_id;

  -- keep the payments ledger truthful (mirrors create_order) so paid_idr == Σ payments holds.
  if coalesce(p_amount, 0) > 0 then
    v_today := (now() at time zone 'Asia/Jakarta')::date;
    insert into payments (sales_id, amount_idr, type, method, paid_date, note)
    values (p_sales_id, p_amount,
            case when v_total > 0 and v_paid >= v_total then 'Settlement' else 'DP' end,
            v_method, v_today, 'mark_order_paid');
  end if;

  return jsonb_build_object(
    'payment_status', v_pay_status,
    'status',         v_status,
    'paid',           v_paid,
    'balance',        greatest(v_total - v_paid, 0)
  );
end;
$$;

revoke all on function public.mark_order_paid(text, bigint, text) from public, anon;
grant execute on function public.mark_order_paid(text, bigint, text) to authenticated, service_role;

-- ============== 3. unfulfill_order ==============
create or replace function public.unfulfill_order(p_sales_id text)
returns text[]
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_codes text[] := '{}';
  v_count int := 0;
begin
  -- Inverse of fulfill_order for ALL fulfilled-but-unshipped, non-cancelled lines of the order
  -- (all-or-none — the partial decision is re-made at Fulfill). Clears fulfilled_at + every courier
  -- field so the lines return to the Fulfill queue. Stock restores automatically: the stock_check
  -- view stops counting these as reserved, so available rises.
  --   address_id is intentionally LEFT as-is — create_order sets it per line and the next fulfill
  --   coalesces a fresh choice over it; we can't distinguish a fulfill-set address from the
  --   creation-set one, and nulling it would lose the order's address.
  --   HOLDS: fulfill_order auto-RELEASED holds (capped at fulfilled qty). We deliberately do NOT
  --   re-create them — a return-to-Fulfill restores stock to available only; resurrecting prior
  --   holds is risky and a separate explicit feature if ever needed.
  --   PAYMENT is NOT touched — fulfill/ship never moved money, so neither does the reverse (a
  --   refund only matters on a full cancel, which is a separate unbuilt flow).
  with un as (
    update order_lines
       set fulfilled_at     = null,
           courier          = null,
           courier_speed    = null,
           courier_label    = null,
           courier_tracking = null
     where sales_id = p_sales_id
       and fulfilled_at is not null
       and shipped_at is null
       and not is_cancelled
    returning item_code
  )
  select coalesce(array_agg(distinct item_code) filter (where item_code is not null), '{}'),
         count(*)
    into v_codes, v_count
  from un;

  -- If the order had been Complete, an unfulfilled (unshipped) line now exists → no longer Complete.
  -- (Normally a Ready-to-ship order is already status='Need send'; this is a safety net.)
  if v_count > 0 then
    update orders set status = 'Need send' where sales_id = p_sales_id and status = 'Complete';
  end if;

  return v_codes;
end;
$$;

revoke all on function public.unfulfill_order(text) from public, anon;
grant execute on function public.unfulfill_order(text) to authenticated, service_role;
