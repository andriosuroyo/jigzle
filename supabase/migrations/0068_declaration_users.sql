-- PR205 — SP Declare (Surat Pernyataan) declaration users.
-- A small Settings-managed list of people whose identity (KTP / NPWP / phone / address) fills the
-- customs declaration, picked in Doc Generator → SP Declare. Same house posture as the other settings
-- lists: GLOBAL rows (user_id null), RLS gated by is_allowed_user(). Idempotent / re-runnable.

create table if not exists public.settings_declaration_users (
  id          bigint generated always as identity primary key,
  user_id     text,                        -- NULL = global default
  name        text not null,
  ktp         text,                        -- Nomor KTP/SIM/Pasport
  npwp        text,                        -- nomor NPWP
  phone       text,                        -- No. HP/Email
  address     text,                        -- Alamat (per person)
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists settings_declaration_users_user_sort_idx
  on public.settings_declaration_users (user_id, sort_order);

alter table public.settings_declaration_users enable row level security;
drop policy if exists "settings_declaration_users_all" on public.settings_declaration_users;
create policy "settings_declaration_users_all" on public.settings_declaration_users
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());
grant select, insert, update, delete on public.settings_declaration_users to authenticated, service_role;

-- seed the two known names only (KTP/NPWP/phone/address are filled in via Settings — no government
-- ID numbers are committed to the repo). Skip if any global row already exists → re-runnable.
insert into public.settings_declaration_users (user_id, name, sort_order)
select null, v.name, v.ord
from (values ('Andrio Suroyo', 0), ('Irene Chan', 1)) as v(name, ord)
where not exists (
  select 1 from public.settings_declaration_users where user_id is null
);
