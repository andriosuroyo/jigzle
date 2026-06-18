-- Phase 2 — Stock Check + Snapshots + Adjustments (docs/016 §5/§6, v0.4).
-- THREE new tables (stock_checks / stock_check_lines / adjustments), a signed-delta ledger that
-- trues `available`/`physical` up to the shelf, the `stock_check` view (0009) extended with that
-- ledger, and the atomic RPCs that drive the two count modes.
--
-- Security posture follows the house style: every write RPC is `security invoker` + pinned
-- `search_path`, so RLS (is_allowed_user(), 0017) gates every read/write under the signed-in user;
-- edit/delete of an adjustment is a plain RLS-gated table write (no RPC). Validate-before-write —
-- a rejected close (or open) leaves ZERO residue (the whole function is one transaction).
--
-- Does NOT touch: Inventory/Sales/pricing/Receiving, the stock_snapshot matview (0019) — it reads
-- FROM the stock_check view, so adjustments flow into it automatically on the next refresh — or any
-- other module's RPC. The view change keeps the SAME output columns, so `create or replace view`
-- and every existing reader are unaffected.

-- ============================================================================
-- 1. Tables
-- ============================================================================

-- session / snapshot header
create table if not exists public.stock_checks (
  stock_check_id bigint generated always as identity primary key,
  mode           text not null check (mode in ('presence', 'count')),
  scope          text not null check (scope in ('all_active', 'brand')),
  scope_brands   text[],                                   -- null for all_active
  status         text not null default 'open' check (status in ('open', 'closed', 'cancelled')),
  counted_by     text not null,                            -- free-text "who counted" (shared login)
  note           text,
  started_at     timestamptz not null default now(),
  closed_at      timestamptz,
  created_by     text,                                     -- login email, stamped by the RPC
  created_at     timestamptz not null default now()
);
create index if not exists stock_checks_status_idx on public.stock_checks (status);

-- per-SKU detail within a session = the snapshot detail
create table if not exists public.stock_check_lines (
  line_id           bigint generated always as identity primary key,
  stock_check_id    bigint not null references public.stock_checks(stock_check_id) on delete cascade,
  item_code         text not null references public.catalogue(item_code) on update cascade,
  confirmed         boolean not null default false,        -- ticked (Presence) / scanned (Count)
  counted_qty       int,                                   -- Count: scanned/set number; Presence add-missing: entered qty
  expected_physical int,                                   -- stamped at close (live physical)
  delta             int,                                   -- stamped at close
  review_action     text check (review_action in ('zeroed', 'ignored', 'added')),
  added_missing     boolean not null default false,
  updated_at        timestamptz not null default now(),
  unique (stock_check_id, item_code)
);
create index if not exists stock_check_lines_check_idx on public.stock_check_lines (stock_check_id);
create index if not exists stock_check_lines_item_idx  on public.stock_check_lines (item_code);

-- signed-delta ledger — kept SEPARATE from inbound on purpose (clean audit trail, own tab).
-- Individually editable / deletable (override delta or delete to undo) via plain RLS writes.
create table if not exists public.adjustments (
  adjustment_id  bigint generated always as identity primary key,
  item_code      text not null references public.catalogue(item_code) on update cascade,
  delta          int not null,                             -- signed
  source         text not null check (source in ('stock_check', 'manual')),
  stock_check_id bigint references public.stock_checks(stock_check_id) on delete set null,
  note           text,
  created_by     text,
  created_at     timestamptz not null default now()
);
create index if not exists adjustments_item_idx  on public.adjustments (item_code);
create index if not exists adjustments_check_idx on public.adjustments (stock_check_id);

-- ============================================================================
-- 2. RLS + grants (house pattern: one "<table>_all" policy gated by is_allowed_user())
-- ============================================================================

alter table public.stock_checks      enable row level security;
alter table public.stock_check_lines enable row level security;
alter table public.adjustments       enable row level security;

drop policy if exists "stock_checks_all" on public.stock_checks;
create policy "stock_checks_all" on public.stock_checks
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "stock_check_lines_all" on public.stock_check_lines;
create policy "stock_check_lines_all" on public.stock_check_lines
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "adjustments_all" on public.adjustments;
create policy "adjustments_all" on public.adjustments
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

revoke all on public.stock_checks      from anon;
revoke all on public.stock_check_lines from anon;
revoke all on public.adjustments       from anon;
grant select, insert, update, delete on public.stock_checks      to authenticated, service_role;
grant select, insert, update, delete on public.stock_check_lines to authenticated, service_role;
grant select, insert, update, delete on public.adjustments       to authenticated, service_role;

-- ============================================================================
-- 3. View change — extend stock_check (0009) with the adjustments ledger.
--    Same output columns; `adj` adds the SAME signed delta to BOTH available and physical so
--    `available + reserved + on_hold = physical` stays true by construction.
-- ============================================================================

create or replace view public.stock_check
  with (security_invoker = true)
as
with inb as (
  select item_code,
         sum(qty) filter (where not excluded) as inbound_qty,
         max(receive_date)                    as last_receive
  from public.inbound
  where item_code is not null
  group by item_code
),
sales as (
  select item_code,
         sum(qty) filter (where fulfilled_at is not null and not is_cancelled) as fulfilled_qty,
         sum(qty) filter (where shipped_at   is not null and not is_cancelled) as shipped_qty
  from public.order_lines
  where item_code is not null
  group by item_code
),
hld as (
  select item_code,
         sum(qty) as hold_qty
  from public.holds
  where released_at is null
  group by item_code
),
po as (
  select item_code,
         sum(qty) filter (where status = 'Processing')                    as pending_qty,
         sum(qty) filter (where status in ('On the way', 'With Forwarder')) as on_the_way_qty
  from public.purchase_orders
  where item_code is not null
  group by item_code
),
adj as (
  select item_code, sum(delta) as adj_qty
  from public.adjustments
  group by item_code
)
select
  c.item_code,
  coalesce(inb.inbound_qty, 0)   - coalesce(sales.fulfilled_qty, 0) - coalesce(hld.hold_qty, 0) + coalesce(adj.adj_qty, 0) as available,
  coalesce(inb.inbound_qty, 0)   - coalesce(sales.shipped_qty, 0)                               + coalesce(adj.adj_qty, 0) as physical,
  coalesce(sales.fulfilled_qty, 0) - coalesce(sales.shipped_qty, 0)                             as reserved,
  coalesce(hld.hold_qty, 0)      as on_hold,
  coalesce(po.pending_qty, 0)    as pending,
  coalesce(po.on_the_way_qty, 0) as on_the_way,
  inb.last_receive
from public.catalogue c
left join inb   on inb.item_code   = c.item_code
left join sales on sales.item_code = c.item_code
left join hld   on hld.item_code   = c.item_code
left join po    on po.item_code    = c.item_code
left join adj   on adj.item_code   = c.item_code;

-- session list read model: header + per-session line counts aggregated server-side, so the board
-- never pulls thousands of lines just to render the list (PostgREST caps row reads at ~1000).
create or replace view public.stock_check_summary
  with (security_invoker = true)
as
select s.stock_check_id, s.mode, s.scope, s.scope_brands, s.status, s.counted_by, s.note,
       s.started_at, s.closed_at, s.created_by,
       count(l.line_id)                                             as line_count,
       count(l.line_id) filter (where l.confirmed)                  as confirmed_count,
       count(l.line_id) filter (where l.delta is not null and l.delta <> 0) as changed_count
from public.stock_checks s
left join public.stock_check_lines l on l.stock_check_id = s.stock_check_id
group by s.stock_check_id;

revoke all on public.stock_check_summary from anon;
grant select on public.stock_check_summary to authenticated, service_role;

-- ============================================================================
-- 4. RPCs (atomic, security invoker, RLS-gated, validate-before-write)
-- ============================================================================

-- ============== open_stock_check() ==============
-- Create a session after the overlap guard, then seed a line (confirmed=false) for every in-scope
-- SKU currently ON THE SHELF (live stock_check.physical > 0), so "not yet scanned" / the checklist
-- work from the start. Overlap guard: reject a new scope that overlaps any OPEN session (either
-- side all_active, or a shared brand) — different-brand parallel sessions are allowed.
create or replace function public.open_stock_check(
  p_mode       text,
  p_scope      text,
  p_brands     text[],
  p_counted_by text,
  p_note       text default null
) returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_mode    text   := lower(btrim(p_mode));
  v_scope   text   := lower(btrim(p_scope));
  v_by      text   := btrim(p_counted_by);
  v_brands  text[] := p_brands;
  v_missing text[];
  v_overlap bigint[];
  v_id      bigint;
begin
  -- 1. validate
  if v_mode not in ('presence', 'count') then
    raise exception 'open_stock_check: mode must be presence or count (got %)', p_mode;
  end if;
  if v_scope not in ('all_active', 'brand') then
    raise exception 'open_stock_check: scope must be all_active or brand (got %)', p_scope;
  end if;
  if v_by is null or v_by = '' then
    raise exception 'open_stock_check: counted_by (who is counting) is required';
  end if;
  if v_scope = 'all_active' then
    v_brands := null;
  else
    if v_brands is null or array_length(v_brands, 1) is null then
      raise exception 'open_stock_check: brand scope needs at least one brand';
    end if;
    select array_agg(b order by b) into v_missing
    from unnest(v_brands) as b
    where not exists (select 1 from brands br where br.prefix = b);
    if v_missing is not null then
      raise exception 'open_stock_check: unknown brand prefix(es): %', array_to_string(v_missing, ', ');
    end if;
  end if;

  -- 2. overlap guard
  select array_agg(sc.stock_check_id order by sc.stock_check_id) into v_overlap
  from stock_checks sc
  where sc.status = 'open'
    and (v_scope = 'all_active' or sc.scope = 'all_active' or sc.scope_brands && v_brands);
  if v_overlap is not null then
    raise exception 'open_stock_check: scope overlaps open session(s): %', array_to_string(v_overlap, ', ');
  end if;

  -- 3. create the session
  insert into stock_checks (mode, scope, scope_brands, status, counted_by, note, created_by)
  values (v_mode, v_scope, v_brands, 'open', v_by, nullif(btrim(p_note), ''), lower(auth.jwt() ->> 'email'))
  returning stock_check_id into v_id;

  -- 4. seed lines for every in-scope SKU on the shelf (live physical > 0)
  insert into stock_check_lines (stock_check_id, item_code)
  select v_id, sc.item_code
  from stock_check sc
  join catalogue c on c.item_code = sc.item_code
  where sc.physical > 0
    and (v_scope = 'all_active' or c.brand_prefix = any (v_brands));

  return v_id;
end;
$$;

-- ============== confirm_present() / unconfirm() ==============
-- Presence tick toggle (open-session guard). counted_qty is untouched — Presence is qualitative.
create or replace function public.confirm_present(p_line_id bigint)
returns void language plpgsql security invoker set search_path = public as $$
begin
  update stock_check_lines l
     set confirmed = true, updated_at = now()
    from stock_checks s
   where l.line_id = p_line_id and s.stock_check_id = l.stock_check_id and s.status = 'open';
  if not found then
    raise exception 'confirm_present: line % not found or its session is not open', p_line_id;
  end if;
end; $$;

create or replace function public.unconfirm(p_line_id bigint)
returns void language plpgsql security invoker set search_path = public as $$
begin
  update stock_check_lines l
     set confirmed = false, updated_at = now()
    from stock_checks s
   where l.line_id = p_line_id and s.stock_check_id = l.stock_check_id and s.status = 'open';
  if not found then
    raise exception 'unconfirm: line % not found or its session is not open', p_line_id;
  end if;
end; $$;

-- ============== record_count() ==============
-- Count set/increment + confirmed=true. op='set' → counted_qty = qty; op='inc' → counted_qty += qty
-- (a scan is op='inc', qty=1). A SKU not seeded in scope (scanned from outside the scope) is
-- created as an added_missing line. Returns the new counted_qty.
create or replace function public.record_count(
  p_stock_check_id bigint,
  p_item_code      text,
  p_op             text,
  p_qty            int
) returns int
language plpgsql security invoker set search_path = public as $$
declare
  v_op   text := lower(btrim(p_op));
  v_code text := btrim(p_item_code);
  v_open boolean;
  v_new  int;
begin
  if v_op not in ('set', 'inc') then
    raise exception 'record_count: op must be set or inc (got %)', p_op;
  end if;
  if v_code is null or v_code = '' then
    raise exception 'record_count: item_code is required';
  end if;
  if p_qty is null then
    raise exception 'record_count: qty is required';
  end if;
  if v_op = 'set' and p_qty < 0 then
    raise exception 'record_count: set qty cannot be negative';
  end if;

  select (status = 'open') into v_open from stock_checks where stock_check_id = p_stock_check_id;
  if v_open is null then raise exception 'record_count: session % not found', p_stock_check_id; end if;
  if not v_open then raise exception 'record_count: session % is not open', p_stock_check_id; end if;
  if not exists (select 1 from catalogue where item_code = v_code) then
    raise exception 'record_count: unknown item_code %', v_code;
  end if;

  insert into stock_check_lines (stock_check_id, item_code, confirmed, counted_qty, added_missing)
  values (p_stock_check_id, v_code, true, case when v_op = 'set' then p_qty else greatest(p_qty, 0) end, true)
  on conflict (stock_check_id, item_code) do update
    set counted_qty = case when v_op = 'set' then p_qty
                           else greatest(coalesce(stock_check_lines.counted_qty, 0) + p_qty, 0) end,
        confirmed   = true,
        updated_at  = now()
  returning counted_qty into v_new;

  return v_new;
end; $$;

-- ============== add_missing_sku() ==============
-- A SKU physically present but not on the checklist → a line with added_missing=true and the
-- entered qty in counted_qty (used in BOTH modes; at close → an adjustment of +counted_qty).
create or replace function public.add_missing_sku(
  p_stock_check_id bigint,
  p_item_code      text,
  p_qty            int
) returns bigint
language plpgsql security invoker set search_path = public as $$
declare
  v_code text := btrim(p_item_code);
  v_open boolean;
  v_line bigint;
begin
  if v_code is null or v_code = '' then
    raise exception 'add_missing_sku: item_code is required';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'add_missing_sku: a positive qty is required';
  end if;
  select (status = 'open') into v_open from stock_checks where stock_check_id = p_stock_check_id;
  if v_open is null then raise exception 'add_missing_sku: session % not found', p_stock_check_id; end if;
  if not v_open then raise exception 'add_missing_sku: session % is not open', p_stock_check_id; end if;
  if not exists (select 1 from catalogue where item_code = v_code) then
    raise exception 'add_missing_sku: unknown item_code %', v_code;
  end if;
  -- a SKU already SEEDED in scope is on the checklist — adding it would double-count at close
  -- (it already carries its on-shelf physical). Tick/scan/set it instead.
  if exists (
    select 1 from stock_check_lines
    where stock_check_id = p_stock_check_id and item_code = v_code and added_missing = false
  ) then
    raise exception 'add_missing_sku: % is already on the checklist — tick/scan or set its count instead', v_code;
  end if;

  insert into stock_check_lines (stock_check_id, item_code, confirmed, counted_qty, added_missing)
  values (p_stock_check_id, v_code, true, p_qty, true)
  on conflict (stock_check_id, item_code) do update
    set counted_qty = p_qty, confirmed = true, added_missing = true, updated_at = now()
  returning line_id into v_line;

  return v_line;
end; $$;

-- ============== close_stock_check() ==============
-- ONE transaction. Stamp expected_physical from the LIVE view, then:
--   Count    → adjustment per non-zero (counted_qty − expected) for COUNTED lines only
--              (un-scanned = no-op; an explicit set-0 is counted_qty=0 → −expected).
--   Presence → adjustment only for review entries marked 'zeroed' (−expected) + added-missing (+qty);
--              every un-ticked, non-added line MUST carry a 'zeroed'/'ignored' decision (else reject).
-- p_review = jsonb array of {item_code, action in (zeroed,ignored)}; carries the per-un-scanned/
-- un-ticked choices the close-confirm window collects. Failure leaves zero residue.
create or replace function public.close_stock_check(
  p_stock_check_id bigint,
  p_review         jsonb default '[]'::jsonb
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_mode      text;
  v_status    text;
  v_email     text := lower(auth.jwt() ->> 'email');
  v_review    jsonb := coalesce(p_review, '[]'::jsonb);
  v_uncovered text[];
  v_adjs      jsonb;
  v_confirmed int;
  v_changed   int;
  v_net       int;
begin
  -- validate session + review shape FIRST (no writes yet)
  select mode, status into v_mode, v_status from stock_checks where stock_check_id = p_stock_check_id;
  if v_mode is null then raise exception 'close_stock_check: session % not found', p_stock_check_id; end if;
  if v_status <> 'open' then raise exception 'close_stock_check: session % is not open', p_stock_check_id; end if;

  if exists (
    select 1 from jsonb_array_elements(v_review) e
    where coalesce(e ->> 'action', '') not in ('zeroed', 'ignored')
       or coalesce(e ->> 'item_code', '') = ''
  ) then
    raise exception 'close_stock_check: review entries need item_code + action in (zeroed, ignored)';
  end if;

  -- Presence: every un-ticked, non-added line must have a decision
  if v_mode = 'presence' then
    select array_agg(l.item_code order by l.item_code) into v_uncovered
    from stock_check_lines l
    where l.stock_check_id = p_stock_check_id
      and l.confirmed = false
      and l.added_missing = false
      and not exists (select 1 from jsonb_array_elements(v_review) e where e ->> 'item_code' = l.item_code);
    if v_uncovered is not null then
      raise exception 'close_stock_check: % un-ticked SKU(s) need a set-0/leave decision: %',
        array_length(v_uncovered, 1), array_to_string(v_uncovered, ', ');
    end if;
  end if;

  -- 1. stamp expected_physical from the live view
  update stock_check_lines l
     set expected_physical = coalesce(v.physical, 0), updated_at = now()
    from (select item_code, physical from stock_check) v
   where l.stock_check_id = p_stock_check_id and v.item_code = l.item_code;
  update stock_check_lines
     set expected_physical = 0
   where stock_check_id = p_stock_check_id and expected_physical is null;

  -- 2. record the review decisions on the lines (both modes)
  update stock_check_lines l
     set review_action = e.action, updated_at = now()
    from (select x ->> 'item_code' as item_code, x ->> 'action' as action
          from jsonb_array_elements(v_review) x) e
   where l.stock_check_id = p_stock_check_id and l.item_code = e.item_code;

  -- 3. 'zeroed' (either mode) → adjustment of −expected (skip when expected already 0)
  insert into adjustments (item_code, delta, source, stock_check_id, note, created_by)
  select l.item_code, -l.expected_physical, 'stock_check', p_stock_check_id, 'count: set to 0', v_email
  from stock_check_lines l
  where l.stock_check_id = p_stock_check_id
    and l.review_action = 'zeroed'
    and coalesce(l.expected_physical, 0) <> 0;
  update stock_check_lines
     set delta = -expected_physical
   where stock_check_id = p_stock_check_id and review_action = 'zeroed' and coalesce(expected_physical, 0) <> 0;

  -- 4. Count → adjustment per non-zero (counted − expected) for COUNTED, non-zeroed lines
  if v_mode = 'count' then
    insert into adjustments (item_code, delta, source, stock_check_id, note, created_by)
    select l.item_code, (l.counted_qty - coalesce(l.expected_physical, 0)), 'stock_check', p_stock_check_id, 'count delta', v_email
    from stock_check_lines l
    where l.stock_check_id = p_stock_check_id
      and l.counted_qty is not null
      and l.review_action is distinct from 'zeroed'
      and (l.counted_qty - coalesce(l.expected_physical, 0)) <> 0;
    update stock_check_lines l
       set delta = (l.counted_qty - coalesce(l.expected_physical, 0))
     where l.stock_check_id = p_stock_check_id
       and l.counted_qty is not null
       and l.review_action is distinct from 'zeroed';
  end if;

  -- 5. Presence added-missing → adjustment of +counted_qty
  if v_mode = 'presence' then
    insert into adjustments (item_code, delta, source, stock_check_id, note, created_by)
    select l.item_code, l.counted_qty, 'stock_check', p_stock_check_id, 'added missing', v_email
    from stock_check_lines l
    where l.stock_check_id = p_stock_check_id
      and l.added_missing = true
      and coalesce(l.counted_qty, 0) <> 0;
    update stock_check_lines
       set delta = counted_qty, review_action = 'added'
     where stock_check_id = p_stock_check_id and added_missing = true;
  end if;

  -- 6. close
  update stock_checks set status = 'closed', closed_at = now() where stock_check_id = p_stock_check_id;

  -- 7. summary
  select coalesce(jsonb_agg(jsonb_build_object('item_code', item_code, 'delta', delta) order by item_code), '[]'::jsonb)
    into v_adjs
  from adjustments where stock_check_id = p_stock_check_id;

  select count(*) filter (where confirmed),
         count(*) filter (where delta is not null and delta <> 0),
         coalesce(sum(delta) filter (where delta is not null), 0)
    into v_confirmed, v_changed, v_net
  from stock_check_lines where stock_check_id = p_stock_check_id;

  return jsonb_build_object(
    'stock_check_id', p_stock_check_id,
    'confirmed',      v_confirmed,
    'changed',        v_changed,
    'net',            v_net,
    'adjustments',    v_adjs
  );
end; $$;

-- ============== cancel_stock_check() ==============
-- Abandon an open session WITHOUT writing any adjustment — frees its scope (the overlap guard only
-- blocks against OPEN sessions, so a mistaken/abandoned session would otherwise lock its brands).
create or replace function public.cancel_stock_check(p_stock_check_id bigint)
returns void language plpgsql security invoker set search_path = public as $$
declare v_status text;
begin
  select status into v_status from stock_checks where stock_check_id = p_stock_check_id;
  if v_status is null then raise exception 'cancel_stock_check: session % not found', p_stock_check_id; end if;
  if v_status <> 'open' then raise exception 'cancel_stock_check: session % is not open', p_stock_check_id; end if;
  update stock_checks set status = 'cancelled', closed_at = now() where stock_check_id = p_stock_check_id;
end; $$;

-- ============== create_manual_adjustment() ==============
-- One-off correction outside a count (Adjustments tab). Edit/delete of any adjustment afterward is
-- a plain RLS-gated UPDATE/DELETE — no RPC.
create or replace function public.create_manual_adjustment(
  p_item_code text,
  p_delta     int,
  p_note      text
) returns bigint
language plpgsql security invoker set search_path = public as $$
declare
  v_code text := btrim(p_item_code);
  v_id   bigint;
begin
  if v_code is null or v_code = '' then
    raise exception 'create_manual_adjustment: item_code is required';
  end if;
  if p_delta is null or p_delta = 0 then
    raise exception 'create_manual_adjustment: a non-zero delta is required';
  end if;
  if not exists (select 1 from catalogue where item_code = v_code) then
    raise exception 'create_manual_adjustment: unknown item_code %', v_code;
  end if;

  insert into adjustments (item_code, delta, source, note, created_by)
  values (v_code, p_delta, 'manual', nullif(btrim(p_note), ''), lower(auth.jwt() ->> 'email'))
  returning adjustment_id into v_id;
  return v_id;
end; $$;

-- ============== grants ==============
revoke all on function public.open_stock_check(text, text, text[], text, text)   from public, anon;
revoke all on function public.confirm_present(bigint)                            from public, anon;
revoke all on function public.unconfirm(bigint)                                  from public, anon;
revoke all on function public.record_count(bigint, text, text, int)             from public, anon;
revoke all on function public.add_missing_sku(bigint, text, int)                 from public, anon;
revoke all on function public.close_stock_check(bigint, jsonb)                   from public, anon;
revoke all on function public.cancel_stock_check(bigint)                         from public, anon;
revoke all on function public.create_manual_adjustment(text, int, text)          from public, anon;

grant execute on function public.open_stock_check(text, text, text[], text, text) to authenticated, service_role;
grant execute on function public.confirm_present(bigint)                         to authenticated, service_role;
grant execute on function public.unconfirm(bigint)                               to authenticated, service_role;
grant execute on function public.record_count(bigint, text, text, int)          to authenticated, service_role;
grant execute on function public.add_missing_sku(bigint, text, int)             to authenticated, service_role;
grant execute on function public.close_stock_check(bigint, jsonb)               to authenticated, service_role;
grant execute on function public.cancel_stock_check(bigint)                      to authenticated, service_role;
grant execute on function public.create_manual_adjustment(text, int, text)      to authenticated, service_role;
