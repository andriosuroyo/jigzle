-- 0035 — Notes model + Mark-shipped verification capture.
--
-- Two parts, both additive/safe:
--   1. settings_common_notes — a Settings-managed pick-list of reusable shipment notes (gift wrap,
--      free gift, …). Mirrors the other settings_* lists (0028): NULL user_id = global default,
--      sort_order, is_active, RLS via is_allowed_user(). The note-editor (Pending/Fulfill) offers these
--      as a dropdown alongside free text. order_lines.line_note (the per-line note) ALREADY EXISTS
--      (0005), so no column is added — this migration only adds the common-notes list + ship capture.
--   2. record_shipment — on Mark-shipped, stamp each outbound_shipments row with the line's note and
--      the operator's verification (verify_method 'scan'|'manual' + scanned_barcode). Those columns
--      exist already (0034); today they're only filled by the CSV reconcile. This makes app ships fill
--      them too, so the report/History ✅/○ marks and notes work going forward. Adds a p_verify param
--      (defaulted, so the current app call keeps working until the Outbound board wires it up).

-- ============== 1. settings_common_notes ==============
create table if not exists public.settings_common_notes (
  id          bigint generated always as identity primary key,
  user_id     text,                          -- NULL = global default (this PR writes only NULL)
  label       text    not null,              -- the note text, e.g. 'Gift wrap', 'Free gift included'
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists settings_common_notes_user_sort_idx on public.settings_common_notes (user_id, sort_order);

alter table public.settings_common_notes enable row level security;
drop policy if exists "settings_common_notes_all" on public.settings_common_notes;
create policy "settings_common_notes_all" on public.settings_common_notes
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

-- seed a few common notes (global rows; idempotent — guarded by NOT EXISTS on the label)
insert into public.settings_common_notes (user_id, label, sort_order)
select null, v.label, v.ord
from (values
  ('Gift wrap',           0),
  ('Free gift included',  1),
  ('Fragile',             2),
  ('No invoice inside',   3),
  ('Bubble wrap extra',   4)
) as v(label, ord)
where not exists (
  select 1 from public.settings_common_notes n
  where n.user_id is null and n.label = v.label
);

-- ============== 2. record_shipment — capture line note + verification ==============
-- Body identical to 0029 EXCEPT: (a) new defaulted p_verify param, (b) the shipped CTE also returns
-- line_note, (c) the outbound_shipments insert stamps note / verify_method / scanned_barcode. Adding a
-- defaulted param creates a DIFFERENT signature (6 args) that would be ambiguous with the old 5-arg one,
-- so drop the old overload first, then create the new function.
drop function if exists public.record_shipment(text, text[], text, text, jsonb);

create or replace function public.record_shipment(
  p_sales_id text,
  p_line_ids text[],
  p_courier  text,
  p_tracking text,
  p_boxes    jsonb,
  p_verify   jsonb default '[]'::jsonb   -- [{ line_id, method: 'scan'|'manual', barcode }] — per shipped line
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

  -- allocate SND-YYMM-#### under an advisory lock (monthly counter; same safety as the JZ ids).
  v_today  := (now() at time zone 'Asia/Jakarta')::date;
  v_period := to_char(v_today, 'YYMM');
  perform pg_advisory_xact_lock(hashtext('jz_send_seq'), hashtext(v_period));
  select coalesce(max(substring(send_id from 10 for 4)::int), 0) + 1 into v_seq
    from outbound_shipments where send_id like 'SND-' || v_period || '-%';
  v_send_id := 'SND-' || v_period || '-' || lpad(v_seq::text, 4, '0');

  -- ship the eligible lines (already fulfilled, not yet shipped, not cancelled) and write one
  -- outbound_shipments row per shipped line. Capture affected codes + count.
  -- PR26 (O4): courier/tracking are set at Fulfill and travel on the line; Outbound no longer sends
  -- them (passes null). COALESCE so a null payload PRESERVES the fulfill-stamped values rather than
  -- wiping them; the outbound_shipments row then takes the line's own courier (what reconciliation reads).
  -- 0035: also carry the line's note onto the row, and join p_verify (by line_id) to stamp how the item
  -- was checked at ship — verify_method 'scan'|'manual' + the scanned barcode (constraint allows NULLs).
  with shipped as (
    update order_lines
       set shipped_at       = now(),
           courier          = coalesce(p_courier, courier),
           courier_tracking = coalesce(p_tracking, courier_tracking)
     where line_id = any(p_line_ids) and sales_id = p_sales_id
       and fulfilled_at is not null and shipped_at is null and not is_cancelled
    returning line_id, item_code, qty, address_id, courier, line_note
  ),
  ins as (
    insert into outbound_shipments
      (sales_id, order_line_id, send_id, customer_id, item_code, qty, ship_date, address, courier,
       note, verify_method, scanned_barcode)
    select p_sales_id, s.line_id, v_send_id, v_cust, s.item_code, s.qty, v_today, ca.raw_address, s.courier,
           s.line_note,
           v.method,
           case when v.method = 'scan' then v.barcode else null end
    from shipped s
    left join customer_addresses ca on ca.address_id = coalesce(s.address_id, v_order_addr)
    left join jsonb_to_recordset(coalesce(p_verify, '[]'::jsonb))
                as v(line_id text, method text, barcode text) on v.line_id = s.line_id
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

  -- boxes for this send. RECOMPUTE vol_weight / chargeable_weight server-side — trust the box's own
  -- real_weight + dims, never any client-sent chargeable. vol = ceil·ceil·ceil/6 (GRAMS — PR26 fix,
  -- was /6000); chargeable = max(real, vol) via GREATEST (which ignores NULLs, so a box with no dims
  -- bills by real and a box with no real bills by vol). bill_by_volume kept (defaults false) but is
  -- cosmetic — chargeable is always the larger.
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

revoke all on function public.record_shipment(text, text[], text, text, jsonb, jsonb) from public, anon;
grant execute on function public.record_shipment(text, text[], text, text, jsonb, jsonb) to authenticated, service_role;
