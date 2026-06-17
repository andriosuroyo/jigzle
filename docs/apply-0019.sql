-- apply-0019.sql
-- Paste-ready for the Supabase SQL editor (ref tocmwitawwtxmnwrbyab). Run it once.
-- SQL is identical to supabase/migrations/0019_stock_snapshot.sql; only this banner is added.
--
-- What it does: adds the Inventory (Stock Check) screen's read-only data layer —
--   * stock_snapshot           : a SEPARATE materialized view over stock_check ⋈ catalogue, ACTIVE
--                                SKUs only (pending / on_the_way / physical > 0), with name + brand
--                                + a refreshed_at ("as of") stamp.
--   * refresh_stock_snapshot() : the on-demand Refresh button (SECURITY DEFINER, non-concurrent).
--   * pg_cron schedule         : OPTIONAL 5-min auto-refresh, added only if pg_cron is enabled.
--
-- It does NOT materialize or change the shared stock_check view (0009 stays live so the action
-- screens keep showing real-time numbers), and does not touch catalogue, the importer, or any RPC.
--
-- pg_cron note: the 5-minute auto-refresh is OPTIONAL. If pg_cron is not enabled on the project,
-- this file still applies cleanly and the manual Refresh button works. To enable the auto-refresh:
-- enable the pg_cron extension in the Supabase dashboard (Database → Extensions), then RE-RUN this
-- file — every statement here is idempotent, so the re-run only adds the cron schedule.
--
-- After this runs, the /inventory screen works.

-- ============================================================================
-- 0019_stock_snapshot.sql
-- ============================================================================

-- ============== stock_snapshot (materialized) ==============
-- now() is the refresh transaction's start time → the same refreshed_at on every row, i.e. the
-- snapshot's "as of". A matview does not enforce RLS; this holds only stock aggregates (no PII).
create materialized view if not exists public.stock_snapshot as
select s.item_code,
       coalesce(c.translate_name, c.original_name) as name,
       c.brand_prefix,
       s.pending,
       s.on_the_way,
       s.physical,
       s.available,
       s.reserved,
       s.on_hold,
       s.last_receive,
       now() as refreshed_at
from public.stock_check s
join public.catalogue c using (item_code)
where s.pending > 0 or s.on_the_way > 0 or s.physical > 0;

-- unique index → required for REFRESH MATERIALIZED VIEW CONCURRENTLY (the pg_cron path)
create unique index if not exists stock_snapshot_item_code_idx on public.stock_snapshot (item_code);

-- readable by the signed-in operator (authenticated) + the service role (smoke harness); never anon.
revoke all on public.stock_snapshot from anon;
grant select on public.stock_snapshot to authenticated, service_role;

-- ============== refresh_stock_snapshot() ==============
-- SECURITY DEFINER: a refresh requires ownership of the matview (held by the migration runner);
-- the app calls this with the anon key + the user session (role authenticated) via the Refresh
-- button, and the smoke harness calls it as service_role. Pinned search_path. Non-concurrent.
create or replace function public.refresh_stock_snapshot()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  refresh materialized view public.stock_snapshot;
end;
$$;

revoke all on function public.refresh_stock_snapshot() from public, anon;
grant execute on function public.refresh_stock_snapshot() to authenticated, service_role;

-- ============== optional pg_cron 5-min concurrent refresh ==============
-- Scheduled ONLY if pg_cron is already enabled — enable it in the Supabase dashboard, then re-run
-- this file. Never fatal: the manual Refresh button works regardless. cron.schedule upserts by job
-- name, so re-running is safe. We deliberately do NOT `create extension pg_cron` (needs superuser).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('refresh-stock-snapshot', '*/5 * * * *',
                          'refresh materialized view concurrently public.stock_snapshot');
  end if;
end $$;

-- Confirm it's in:
-- select count(*) as active_skus, max(refreshed_at) as as_of from public.stock_snapshot;
