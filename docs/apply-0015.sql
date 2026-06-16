-- apply-0015.sql
-- Paste-ready bundle for the Supabase SQL editor. Adds the Receiving (Inbound) module: the
-- catalogue.needs_review flag (D2), the record_receipt() RPC, and the next_adhoc_ship_id()
-- 📦YYMMXXX allocator. SQL is identical to supabase/migrations/0015_receiving.sql; only this
-- banner is added. Additive — it does not touch the stock_check view, create_order,
-- fulfill_order, record_shipment, the importer, or any migration < 0015. Run it once
-- (ref tocmwitawwtxmnwrbyab).

-- ============================================================================
-- 0015_receiving.sql
-- ============================================================================

-- ============== a. D2: needs_review flag ==============
alter table public.catalogue
  add column if not exists needs_review boolean not null default false;

create index if not exists catalogue_needs_review_idx
  on public.catalogue (needs_review) where needs_review;

-- ============== b. record_receipt() ==============
create or replace function public.record_receipt(
  p_ship_id        text,
  p_receive_date   date,
  p_lines          jsonb,
  p_close_shipment boolean
) returns text[]
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tracking text;
  v_is_ship  boolean;
  v_codes    text[];
  v_missing  text[];
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1 then
    raise exception 'record_receipt: at least one receive line is required';
  end if;

  select array_agg(distinct code) into v_missing
  from (
    select coalesce(nullif(l->>'item_code', ''), '(blank)') as code
    from jsonb_array_elements(p_lines) as l
  ) s
  where not exists (select 1 from catalogue c where c.item_code = s.code);
  if v_missing is not null then
    raise exception 'record_receipt: unknown/blank item_code(s): %', array_to_string(v_missing, ', ');
  end if;

  select tracking into v_tracking from shipments where ship_id = p_ship_id;
  v_is_ship := found;

  with ins as (
    insert into public.inbound
      (item_code, qty, ship_id, receive_date, excluded, label, dimension_weight, tracking)
    select l->>'item_code',
           (l->>'qty')::int,
           p_ship_id,
           p_receive_date,
           coalesce((l->>'excluded')::boolean, false),
           nullif(l->>'label', ''),
           nullif(l->>'dimension_weight', ''),
           v_tracking
    from jsonb_array_elements(p_lines) as l
    returning item_code
  )
  select coalesce(array_agg(distinct item_code) filter (where item_code is not null), '{}')
    into v_codes
  from ins;

  if p_close_shipment and v_is_ship then
    update shipments
       set received_date = p_receive_date, status = 'completed'
     where ship_id = p_ship_id;
  end if;

  update purchase_orders
     set status = 'Received', receive_date = p_receive_date
   where ship_id = p_ship_id
     and item_code = any(v_codes)
     and status is distinct from 'Received';

  return v_codes;
end;
$$;

revoke all on function public.record_receipt(text, date, jsonb, boolean) from public, anon;
grant execute on function public.record_receipt(text, date, jsonb, boolean) to authenticated, service_role;

-- ============== c. next_adhoc_ship_id(): the 📦YYMMXXX allocator ==============
create or replace function public.next_adhoc_ship_id()
returns text
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_period text;
  v_seq    int;
begin
  v_period := to_char((now() at time zone 'Asia/Jakarta')::date, 'YYMM');
  perform pg_advisory_xact_lock(hashtext('jz_adhoc_ship_seq'), hashtext(v_period));
  select coalesce(max(substring(ship_id from 6 for 3)::int), 0) + 1 into v_seq
    from inbound
   where ship_id ~ ('^📦' || v_period || '[0-9]{3}$');
  return '📦' || v_period || lpad(v_seq::text, 3, '0');
end;
$$;

revoke all on function public.next_adhoc_ship_id() from public, anon;
grant execute on function public.next_adhoc_ship_id() to authenticated, service_role;
