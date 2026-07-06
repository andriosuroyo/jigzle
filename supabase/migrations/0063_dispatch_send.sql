-- PR198 — Packed vs Dispatched: split the single "shipped" moment into two lifecycle states.
-- Today record_shipment (0035) stamps shipped_at when the operator packs & Mark-ships — but the parcel
-- often still sits on the table, not yet handed to the courier. That conflation is why cancelling felt
-- risky. This adds an explicit DISPATCH step (courier hand-off) as the point of no return:
--   • PACKED     = shipped_at set, dispatched_at null → freely reversible (cancel_shipment).
--   • DISPATCHED = dispatched_at set → the parcel has left; cancel is refused.
-- Purely a lifecycle marker: dispatch moves NO stock (physical/reserved already moved at pack). Additive
-- and safe — every existing send starts PACKED (dispatched_at null), matching today's behaviour; the
-- operator marks dispatch going forward. No backfill.
--
--   1. outbound_shipments.dispatched_at — nullable timestamp, stamped across a send's rows at dispatch.
--   2. dispatch_send(p_send_id) — stamp dispatched_at = now() on the send's still-packed rows (idempotent).
--   3. cancel_shipment — SUPERSEDES 0062: refuse a send that is already dispatched. Exact superset —
--      with dispatched_at null everywhere (every send today) it behaves identically to 0062.

-- ============== 1. dispatched_at column ==============
alter table public.outbound_shipments
  add column if not exists dispatched_at timestamptz;   -- null = packed; set = dispatched (courier took it)

create index if not exists outbound_shipments_dispatched_idx
  on public.outbound_shipments (send_id) where dispatched_at is not null;

-- ============== 2. dispatch_send ==============
create or replace function public.dispatch_send(p_send_id text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_n int;
begin
  update outbound_shipments
     set dispatched_at = now()
   where send_id = p_send_id and dispatched_at is null;
  get diagnostics v_n = row_count;

  -- nothing stamped → either the send doesn't exist (error) or it's already fully dispatched (idempotent no-op)
  if v_n = 0 and not exists (select 1 from outbound_shipments where send_id = p_send_id) then
    raise exception 'dispatch_send: send % not found', p_send_id;
  end if;
end;
$$;
revoke all on function public.dispatch_send(text) from public, anon;
grant execute on function public.dispatch_send(text) to authenticated, service_role;

-- ============== 3. cancel_shipment — refuse a dispatched send (supersedes 0062) ==============
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

  -- PR198: a dispatched send has left for the courier — it is the point of no return.
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
