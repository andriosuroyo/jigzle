-- PR18 §5 — Checkbox mode goes quantitative ("Scan without the scanner").
--
-- The ONLY change vs 0022 is a new presence branch (step 4b) in close_stock_check: a TICKED
-- Checkbox row now carries a counted_qty (set via record_count, exactly like Scan), and at close it
-- writes the SAME stock_check-sourced adjustment Scan does — (counted_qty − expected) — for any
-- ticked, non-added, non-zeroed row whose count differs from the live shelf. Count mode is left
-- byte-for-byte identical; presence zeroed (step 3, −expected) and presence added-missing (step 5,
-- +counted_qty) are unchanged. No new table/column; no new RPC; create-or-replace only (re-runnable).
--
-- Backward-safe: a pre-PR18 open presence session's ticked rows have counted_qty = NULL (old
-- confirm_present path), so step 4b's `counted_qty is not null` skips them → "present, no change",
-- the old behavior. Un-ticked rows (confirmed = false) are excluded from 4b and still flow through
-- the close-confirm set-0/leave decision — never auto-zeroed.

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

  -- 4b. Presence (Checkbox quantitative, PR18 §5) → adjustment per TICKED row whose counted_qty
  --     differs from expected — the SAME (counted − expected) Scan writes. added_missing rows are
  --     excluded here and handled by step 5 (+counted_qty); zeroed rows by step 3 (−expected).
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
