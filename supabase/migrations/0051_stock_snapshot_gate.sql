-- L2 (audit) — bring stock_snapshot into line with the rest of the schema's access model.
--
-- Every base table gates reads/writes on is_allowed_user() (0017). The stock_snapshot MATVIEW
-- (0019) was the one hole: a matview cannot carry RLS, and 0019 simply `grant select … to
-- authenticated`, so ANY signed-in Supabase session — even an email that is NOT on the
-- allow-list — could read the stock aggregates straight off PostgREST (the app middleware gates
-- the UI, but not the API). Low-risk (no PII, just counts) but inconsistent; this closes it.
--
-- Approach that keeps every existing app read working unchanged: the app reads
-- `.from('stock_snapshot')` in inventory / pending / sales / inbound actions, so we KEEP that name.
-- We rename the matview to stock_snapshot_mat, revoke direct client access to it, and put a gated
-- VIEW named stock_snapshot in its place. The view is a plain (security-definer) view owned by the
-- migration runner, so it can read the locked matview while `authenticated` cannot touch the matview
-- directly — the only way through is the view, whose WHERE enforces is_allowed_user(). The
-- service-role smoke harness (scripts/smoke_inventory.py) reads the same name + calls the refresh
-- RPC, so both the view predicate and the RPC guard also admit the service_role token.
--
-- Idempotent / re-runnable: the rename is guarded (only fires while stock_snapshot is still a
-- matview), the view + function use create-or-replace, grants are repeatable, and the cron reschedule
-- upserts by job name.

-- ============== 1. rename the matview out of the way (guarded, one-shot) ==============
do $$
begin
  if exists (select 1 from pg_matviews where schemaname = 'public' and matviewname = 'stock_snapshot') then
    alter materialized view public.stock_snapshot rename to stock_snapshot_mat;
    alter index if exists public.stock_snapshot_item_code_idx rename to stock_snapshot_mat_item_code_idx;
  end if;
end $$;

-- Lock the matview: no client role reads it directly. The gated view (owner-privileged) is the only
-- path for the app; the service_role key bypasses these grants for the smoke harness + cron.
revoke all on public.stock_snapshot_mat from anon, authenticated;

-- ============== 2. gated view under the name the app already reads ==============
-- Plain (security-definer) view: underlying matview is read with the OWNER's privileges, so
-- `authenticated` needs no grant on the matview — the WHERE is the gate. is_allowed_user() (0017,
-- security definer) reads the caller's JWT email, so a non-allow-listed session sees zero rows even
-- though it can select the view. The service_role token (auth.jwt()->>'role') is admitted for the
-- harness. Shape is identical to the old matview, so no consumer changes.
create or replace view public.stock_snapshot as
  select item_code, name, brand_prefix, pending, on_the_way, physical,
         available, reserved, on_hold, last_receive, refreshed_at
  from public.stock_snapshot_mat
  where public.is_allowed_user()
     or coalesce(auth.jwt() ->> 'role', '') = 'service_role';

revoke all on public.stock_snapshot from anon;
grant select on public.stock_snapshot to authenticated, service_role;

-- ============== 3. refresh RPC — gate execution, target the renamed matview ==============
-- Same SECURITY DEFINER contract as 0019 (a refresh needs matview ownership), now with an explicit
-- allow-list check so an off-list session can't force a refresh. Pinned search_path. Non-concurrent.
create or replace function public.refresh_stock_snapshot()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (public.is_allowed_user() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'not authorized';
  end if;
  refresh materialized view public.stock_snapshot_mat;
end;
$$;

revoke all on function public.refresh_stock_snapshot() from public, anon;
grant execute on function public.refresh_stock_snapshot() to authenticated, service_role;

-- ============== 4. reschedule the optional pg_cron refresh onto the renamed matview ==============
-- 0019's job string still names the old relation (now a view — a concurrent refresh would fail), so
-- re-point it. Only if pg_cron is enabled; upserts by job name; never fatal.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('refresh-stock-snapshot', '*/5 * * * *',
                          'refresh materialized view concurrently public.stock_snapshot_mat');
  end if;
end $$;
