-- PR195 — Cancel (un-record) an app shipment: the exact reverse of record_shipment (0035) for one
-- send_id. The real-world case: an order is packed and Mark-shipped, then a change is requested BEFORE
-- the parcel is handed to the courier. Today there is no way back — unfulfill_order / returnToFulfill
-- (0030 / 0026) both bail on shipped lines, and the only lever, delete_order (0054), nukes the whole
-- order AND writes −qty adjustments (correct only when the goods truly left the shelf). This adds the
-- missing primitive: un-record the send so its lines fall back into Ready-to-ship, WITHOUT any stock
-- compensation — the parcel never left.
--
-- Two parts, both additive (same posture as 0054): security invoker + pinned search_path; revoke
-- public/anon, grant authenticated/service_role; RLS (is_allowed_user()) gates every underlying read/write.
--   1. shipment_cancel_log — one row per cancel: who, when, and a jsonb snapshot of the deleted
--      outbound_shipments + boxes, so a mistaken cancel can be reconstructed by hand.
--   2. cancel_shipment(p_send_id) — one transaction:
--        • snapshot into shipment_cancel_log (stamped with the signed-in email)
--        • NULL shipped_at on the send's lines → they return to Ready-to-ship (fulfilled_at + courier
--          kept). NO adjustment: the stock_check view (0009) counts Σ shipped from order_lines, so
--          clearing shipped_at restores physical/reserved on its own — exactly right for goods that
--          never left. (Contrast delete_order, which DELETES the lines and so must compensate.)
--        • delete this send's boxes + outbound_shipments rows (a re-ship allocates a fresh send_id)
--        • if the order had gone Complete, an unshipped line now exists → back to 'Need send'
--      Only APP ships (send_id set) can be cancelled; legacy CSV rows carry no send_id and are rejected.

-- ============== 1. shipment_cancel_log ==============
create table if not exists public.shipment_cancel_log (
  log_id       bigint generated always as identity primary key,
  send_id      text not null,
  sales_id     text,
  cancelled_by text,                                -- login email (auth.jwt), stamped by the RPC
  cancelled_at timestamptz not null default now(),
  snapshot     jsonb not null                       -- { shipments, boxes }
);
create index if not exists shipment_cancel_log_send_idx on public.shipment_cancel_log (send_id);

alter table public.shipment_cancel_log enable row level security;
drop policy if exists "shipment_cancel_log_all" on public.shipment_cancel_log;
create policy "shipment_cancel_log_all" on public.shipment_cancel_log
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());
grant select, insert on public.shipment_cancel_log to authenticated, service_role;

-- ============== 2. cancel_shipment ==============
create or replace function public.cancel_shipment(p_send_id text)
returns text[]
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_sales_id text;
  v_line_ids text[];
  v_codes    text[] := '{}';
  v_email    text := lower(auth.jwt() ->> 'email');
begin
  -- resolve the send: APP ships only (send_id set). One send_id = one record_shipment call for one
  -- order (the record_shipment invariant delete_order relies on), so a single sales_id is expected.
  select array_agg(distinct order_line_id) filter (where order_line_id is not null),
         max(sales_id)
    into v_line_ids, v_sales_id
    from outbound_shipments
   where send_id = p_send_id;

  if v_sales_id is null then
    raise exception 'cancel_shipment: send % not found (legacy/CSV rows carry no send_id and cannot be cancelled)', p_send_id;
  end if;

  -- a. audit snapshot FIRST — the log row commits or the whole cancel rolls back
  insert into shipment_cancel_log (send_id, sales_id, cancelled_by, snapshot)
  values (
    p_send_id, v_sales_id, v_email,
    jsonb_build_object(
      'shipments', (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from outbound_shipments s where s.send_id = p_send_id),
      'boxes',     (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from boxes              b where b.send_id = p_send_id)
    )
  );

  -- b. un-ship the lines: clear shipped_at so they drop back into the Ready-to-ship queue (fulfilled_at
  -- + courier kept, so they're addressed and re-shippable). NO compensating adjustment — the parcel
  -- never left, so physical returns and reserved rises the instant shipped_at is null (stock_check
  -- counts Σ shipped from order_lines). courier_tracking is intentionally KEPT so a re-ship can reuse it.
  with un as (
    update order_lines
       set shipped_at = null
     where sales_id = v_sales_id
       and line_id = any(v_line_ids)
       and shipped_at is not null
    returning item_code
  )
  select coalesce(array_agg(distinct item_code) filter (where item_code is not null), '{}')
    into v_codes
  from un;

  -- c. drop this send's boxes + outbound rows — a re-ship rewrites them under a fresh send_id
  delete from boxes              where send_id = p_send_id;
  delete from outbound_shipments where send_id = p_send_id;

  -- d. the order had been Complete (all lines shipped); an unshipped line now exists → back to Need send.
  -- (Mirrors unfulfill_order's safety net; payment_status is a separate column, left untouched.)
  update orders set status = 'Need send' where sales_id = v_sales_id and status = 'Complete';

  return v_codes;
end;
$$;
revoke all on function public.cancel_shipment(text) from public, anon;
grant execute on function public.cancel_shipment(text) to authenticated, service_role;
