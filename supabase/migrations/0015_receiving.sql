-- Phase 1 — Receiving (Inbound) module (J2 — the "+" side of stock). ADDITIVE.
-- This is the ONLY module that ADDS stock: an inbound row with excluded=false raises
-- stock_check.available AND physical by its (signed) qty and updates last_receive.
--
--   a. catalogue.needs_review (D2) — flags receive-time SKU stubs for later admin review.
--      Additive + default false → the ~47k legacy catalogue rows stay false, untouched.
--   b. record_receipt() — the single transactional write path: inserts one inbound row per
--      line, optionally closes the shipment, (D4) auto-marks matching POs Received, and
--      returns the affected item_codes so the client re-reads stock_check.
--   c. next_adhoc_ship_id() — allocates the legacy '📦YYMMXXX' ad-hoc id under a per-period
--      advisory lock (same safety as the JZ-/SND- allocators, never a bare max()+1).
--
-- record_receipt / next_adhoc_ship_id are SECURITY INVOKER with a pinned search_path (same
-- posture as create_order / fulfill_order / record_shipment): the app calls them with the
-- anon key + the user's session, so RLS (is_allowed_user()) gates every write; service_role
-- (the smoke harness) may also call them. Does NOT touch the stock_check view, the importer,
-- migrations < 0015, or the other RPCs.

-- ============== a. D2: needs_review flag ==============
alter table public.catalogue
  add column if not exists needs_review boolean not null default false;

-- partial index: the admin review queue (the few flagged stubs) reads only where true.
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

  -- Every line MUST resolve to an existing catalogue SKU. inbound.item_code is a nullable
  -- FK, but for NEW receipts we never silently NULL it — the UI resolves/creates the SKU
  -- first (D1 picker / D2 stub). Fail loudly listing the offenders rather than letting one
  -- bad code abort the insert with an opaque FK error.
  select array_agg(distinct code) into v_missing
  from (
    select coalesce(nullif(l->>'item_code', ''), '(blank)') as code
    from jsonb_array_elements(p_lines) as l
  ) s
  where not exists (select 1 from catalogue c where c.item_code = s.code);
  if v_missing is not null then
    raise exception 'record_receipt: unknown/blank item_code(s): %', array_to_string(v_missing, ', ');
  end if;

  -- A real ship_id (a shipments ledger entry) lends its tracking to the inbound rows; an
  -- ad-hoc 📦YYMMXXX id matches no shipment, so tracking stays NULL. FOUND reflects the match.
  select tracking into v_tracking from shipments where ship_id = p_ship_id;
  v_is_ship := found;

  -- One inbound row per line. qty is SIGNED (a negative row is a stock correction); excluded
  -- rows (gift/damaged) contribute 0 sellable stock; label is the Exclude/Hold/Tokopedia tag
  -- (nullable). item_code_raw is left NULL — these are app receipts, not import cells.
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

  -- Close the shipment only when the operator confirms (partial receive leaves it open with
  -- the shorts still visible). A no-op for ad-hoc ids that match no shipments row.
  if p_close_shipment and v_is_ship then
    update shipments
       set received_date = p_receive_date, status = 'completed'
     where ship_id = p_ship_id;
  end if;

  -- D4: auto-mark the matching POs Received (+ stamp receive_date). Only POs on THIS ship_id
  -- whose item_code actually arrived, and not already Received. Independent of close — a PO
  -- item that arrived is received whether or not the whole shipment is finished.
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
-- Goods with no shipments-ledger entry get the legacy '📦YYMMXXX' id: 📦 (1 char) + YYMM +
-- a 3-digit counter that restarts at 001 each month (the 📦 icon is what marks an ad-hoc
-- receive). Allocated under a per-period advisory lock — same safety as create_order's JZ-
-- and record_shipment's SND- allocators, never a bare max()+1. The counter is taken over the
-- existing well-formed inbound 📦 ids for the month; the regex guard skips any dirty legacy
-- ad-hoc strings so the substring::int cast can't trip. The operator may override the
-- returned id with free text (an override that names a real shipment just reconciles there).
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
  -- '📦' is one character, then 'YYMM' (4) → the 3-digit counter starts at char position 6.
  select coalesce(max(substring(ship_id from 6 for 3)::int), 0) + 1 into v_seq
    from inbound
   where ship_id ~ ('^📦' || v_period || '[0-9]{3}$');
  return '📦' || v_period || lpad(v_seq::text, 3, '0');
end;
$$;

revoke all on function public.next_adhoc_ship_id() from public, anon;
grant execute on function public.next_adhoc_ship_id() to authenticated, service_role;
