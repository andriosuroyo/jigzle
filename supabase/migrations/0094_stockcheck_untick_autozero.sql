-- PR349 — Checkbox close: un-ticked means "not found" → auto-zeroed.
--
-- Change vs 0024: in PRESENCE (Checkbox) mode, an un-ticked, non-added row is now treated as
-- "not on the shelf" and auto-zeroed at close (−expected adjustment) — the operator no longer has
-- to set each one to 0 by hand. The only opt-out is an explicit review_action = 'ignored' (a row the
-- operator deliberately leaves in stock, e.g. stored elsewhere). The old "every un-ticked SKU needs a
-- set-0/leave decision, else reject" gate is therefore removed.
--
-- COUNT (Scan) mode is UNCHANGED: an un-scanned row stays a no-op (only an explicit 'zeroed' review
-- entry writes −expected). A scan pass can legitimately be partial, so we never auto-zero what simply
-- wasn't reached with the scanner. Checkbox is a deliberate whole-list walk, so un-ticked = not found.
--
-- create-or-replace only (re-runnable); no table/column/RPC-signature change. The app degrades safely
-- before this is applied: the UI now defaults un-ticked rows to 'zeroed', and the OLD function already
-- honours an explicit 'zeroed' review entry — so the same zeroing happens; this migration only drops
-- the mandatory-decision gate and makes the zero automatic even when no review entry is sent.

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

  -- (Removed in PR349: the presence "every un-ticked SKU needs a set-0/leave decision" gate. An
  --  un-ticked row now auto-zeroes below unless explicitly 'ignored', so no decision is required.)

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

  -- 2b. Presence "not found" auto-zero (PR349): an un-ticked, non-added row means the SKU wasn't on
  --     the shelf → mark it 'zeroed', UNLESS the operator explicitly left it ('ignored'). Step 3 then
  --     writes the −expected adjustment uniformly. (Count mode never auto-zeroes — see file header.)
  update stock_check_lines l
     set review_action = 'zeroed', updated_at = now()
   where l.stock_check_id = p_stock_check_id
     and v_mode = 'presence'
     and l.confirmed = false
     and l.added_missing = false
     and l.review_action is distinct from 'ignored';

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

  -- 4b. Presence (Checkbox quantitative, PR18 §5) → adjustment per TICKED row whose counted_qty
  --     differs from expected — the SAME (counted − expected) Scan writes. added_missing rows are
  --     excluded here and handled by step 5 (+counted_qty); zeroed rows by step 3 (−expected).
  --     Un-ticked rows are confirmed = false, so they never enter this branch (they auto-zero in 2b/3).
  if v_mode = 'presence' then
    insert into adjustments (item_code, delta, source, stock_check_id, note, created_by)
    select l.item_code, (l.counted_qty - coalesce(l.expected_physical, 0)), 'stock_check', p_stock_check_id, 'count delta', v_email
    from stock_check_lines l
    where l.stock_check_id = p_stock_check_id
      and l.confirmed = true
      and l.added_missing = false
      and l.counted_qty is not null
      and l.review_action is distinct from 'zeroed'
      and (l.counted_qty - coalesce(l.expected_physical, 0)) <> 0;
    update stock_check_lines l
       set delta = (l.counted_qty - coalesce(l.expected_physical, 0))
     where l.stock_check_id = p_stock_check_id
       and l.confirmed = true
       and l.added_missing = false
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

-- grants unchanged (create-or-replace keeps them, but reassert for a clean re-run)
revoke all on function public.close_stock_check(bigint, jsonb) from public, anon;
grant execute on function public.close_stock_check(bigint, jsonb) to authenticated, service_role;
