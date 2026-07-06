-- PR199 — Order-edit hardening + cancel-to-Pending, from live troubleshooting of the 0579/1299 flow:
--   1. replace_order_lines(p_sales_id, p_lines jsonb) — apply a WHOLE edited item set in one call (the
--      Pending edit modal's "Done"): update kept lines, delete removed ones, insert new ones, recompute.
--      Batch = the modal buffers changes and commits atomically (Cancel discards). Scoped to UNCUT lines
--      (a partial order's cut lines are never touched); refuses an empty result.
--   2. add_order_line — FIX the line-id allocation. The old body parsed the numeric suffix of EVERY
--      line_id, which crashes on legacy/imported orders whose line_ids are random (e.g. 20260330560311HKIZY,
--      not {sales_id}-{n}). Now it derives the next suffix only from lines that match the {sales_id}-{digits}
--      shape — legacy ids are ignored, and the new id can't collide with them.
--   3. cancel_shipment — SUPERSEDES 0063: un-recording a send now returns its items ALL THE WAY to
--      Pending (uncut) so the operator can immediately edit the item list + money, instead of landing in
--      Ready-to-ship (which forced Return-to-Fulfill → Send-back-to-Pending). Clears shipped_at +
--      fulfilled_at + courier fields; re-derives each order's status from its EXISTING payment (never
--      recomputes the total — legacy header totals are preserved). Refuses a dispatched send (from 0063).
--
-- House posture throughout: security invoker + pinned search_path; revoke public/anon, grant
-- authenticated/service_role; RLS (is_allowed_user()) gates the underlying reads/writes.

-- ============== 1. replace_order_lines ==============
create or replace function public.replace_order_lines(p_sales_id text, p_lines jsonb)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_status  text;
  v_addr    bigint;
  v_maxseq  int;
  v_keep    text[];
  v_elem    jsonb;
  v_line_id text;
  v_item    text;
  v_qty     int;
  v_price   bigint;
begin
  select status, address_id into v_status, v_addr from orders where sales_id = p_sales_id;
  if not found then
    raise exception 'replace_order_lines: order % not found', p_sales_id;
  end if;
  if v_status not in ('Need payment', 'Need send') then
    raise exception 'replace_order_lines: order % is % — only a pending order is editable', p_sales_id, v_status;
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1 then
    raise exception 'replace_order_lines: an order must keep at least one item';
  end if;

  -- the existing line_ids the modal still shows (everything else uncut is a removal)
  select coalesce(array_agg(nullif(e->>'line_id', '')) filter (where nullif(e->>'line_id', '') is not null), '{}'::text[])
    into v_keep
  from jsonb_array_elements(p_lines) e;

  -- delete the UNCUT, non-cancelled lines the operator removed (cut/shipped lines are never touched)
  delete from order_lines
   where sales_id = p_sales_id
     and fulfilled_at is null and shipped_at is null and not is_cancelled
     and not (line_id = any(v_keep));

  -- next numeric suffix for any new lines — robust to legacy random line_ids (only count {sales_id}-{digits})
  select coalesce(max(substring(line_id from length(p_sales_id) + 2)::int), 0)
    into v_maxseq
  from order_lines
  where sales_id = p_sales_id
    and line_id like p_sales_id || '-%'
    and substring(line_id from length(p_sales_id) + 2) ~ '^[0-9]+$';

  for v_elem in select * from jsonb_array_elements(p_lines)
  loop
    v_line_id := nullif(v_elem->>'line_id', '');
    v_item    := nullif(v_elem->>'item_code', '');
    v_qty     := coalesce((v_elem->>'qty')::int, 0);
    v_price   := nullif(v_elem->>'unit_price_idr', '')::bigint;   -- blank → null (counts as 0 in recompute)
    if v_qty < 1 then
      raise exception 'replace_order_lines: qty must be at least 1';
    end if;

    if v_line_id is not null and exists (
        select 1 from order_lines
         where line_id = v_line_id and sales_id = p_sales_id
           and fulfilled_at is null and shipped_at is null and not is_cancelled
    ) then
      -- kept line — update qty/price only (line_note, links, address left as they were)
      update order_lines set qty = v_qty, unit_price_idr = v_price where line_id = v_line_id;
    else
      -- new line — uncut, address mirrors the order (as create_order does)
      v_maxseq := v_maxseq + 1;
      insert into order_lines (line_id, sales_id, item_code, qty, unit_price_idr,
                               fulfilled_at, shipped_at, is_cancelled, address_id)
      values (p_sales_id || '-' || v_maxseq, p_sales_id, v_item, v_qty, v_price, null, null, false, v_addr);
    end if;
  end loop;

  perform recompute_order_payment(p_sales_id);
end;
$$;
revoke all on function public.replace_order_lines(text, jsonb) from public, anon;
grant execute on function public.replace_order_lines(text, jsonb) to authenticated, service_role;

-- ============== 2. add_order_line — fixed line-id allocation (supersedes 0061) ==============
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

  -- next suffix from {sales_id}-{digits} lines ONLY (legacy random line_ids are ignored — the old body
  -- parsed every suffix and crashed on them).
  select coalesce(max(substring(line_id from length(p_sales_id) + 2)::int), 0) + 1
    into v_seq
  from order_lines
  where sales_id = p_sales_id
    and line_id like p_sales_id || '-%'
    and substring(line_id from length(p_sales_id) + 2) ~ '^[0-9]+$';
  v_line_id := p_sales_id || '-' || v_seq;

  insert into order_lines (line_id, sales_id, item_code, qty, unit_price_idr, line_note,
                           fulfilled_at, shipped_at, is_cancelled, address_id)
  values (v_line_id, p_sales_id, nullif(p_item_code, ''), p_qty, p_unit_price, nullif(p_line_note, ''),
          null, null, false, v_addr);

  perform recompute_order_payment(p_sales_id);
  return v_line_id;
end;
$$;
revoke all on function public.add_order_line(text, text, int, bigint, text) from public, anon;
grant execute on function public.add_order_line(text, text, int, bigint, text) to authenticated, service_role;

-- ============== 3. cancel_shipment — return items to Pending (supersedes 0063) ==============
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

  -- 0063: a dispatched send has left for the courier — the point of no return.
  if exists (select 1 from outbound_shipments where send_id = p_send_id and dispatched_at is not null) then
    raise exception 'cancel_shipment: send % is already dispatched — it cannot be cancelled', p_send_id;
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

  -- b. return every line of the send ALL THE WAY to Pending: clear shipped_at AND fulfilled_at AND the
  -- courier fields (like unfulfill_order). No stock adjustment — nothing physically left; clearing the
  -- timestamps restores physical + available via the stock_check view.
  with un as (
    update order_lines
       set shipped_at       = null,
           fulfilled_at     = null,
           courier          = null,
           courier_speed    = null,
           courier_label    = null,
           courier_tracking = null
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

  -- d. re-derive each order's status from its EXISTING payment (do NOT recompute the total — an imported
  -- legacy header total must survive the round-trip). Fully paid → Need send; otherwise → Need payment.
  update orders
     set status = case when coalesce(sales_total_idr, 0) > 0 and coalesce(paid_idr, 0) >= sales_total_idr
                       then 'Need send' else 'Need payment' end
   where sales_id = any(v_sales_ids);

  return v_codes;
end;
$$;
revoke all on function public.cancel_shipment(text) from public, anon;
grant execute on function public.cancel_shipment(text) to authenticated, service_role;
