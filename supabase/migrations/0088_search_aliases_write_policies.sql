-- 0088 — PR344: let the Settings → Catalog → Search aliases editor write to public.search_aliases.
-- 0087 created the table with a SELECT policy only (reads for allowed users). The in-app editor mutates
-- through the SSR anon client (RLS enforced, no service-role), so it also needs INSERT + DELETE policies.
-- Rows are global (no user_id column); any allowed user may add/remove an alias. UPDATE isn't needed —
-- the editor is add/remove only (an edit = delete the old pair, add the new one).
--
-- Idempotent: each policy is guarded by a pg_policies existence check. Safe to re-run.

begin;

-- ensure the table exists even if 0087 hasn't been applied in this environment (defensive; matches 0087).
create table if not exists public.search_aliases (
  term  text not null,
  alias text not null,
  primary key (term, alias)
);
alter table public.search_aliases enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'search_aliases' and policyname = 'search_aliases_insert'
  ) then
    create policy search_aliases_insert on public.search_aliases
      for insert with check (public.is_allowed_user());
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'search_aliases' and policyname = 'search_aliases_delete'
  ) then
    create policy search_aliases_delete on public.search_aliases
      for delete using (public.is_allowed_user());
  end if;
end $$;

commit;
