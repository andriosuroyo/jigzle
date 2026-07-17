-- 0095 — CN document addresses (PR356): a Settings-managed pick-list of named addresses shared by the
-- CN Invoice's shipper AND consignee selectors. One list on purpose — a party that is a consignee today
-- may be a shipper tomorrow, so both pickers draw from the same set. Each row is a label (e.g. "MTE")
-- plus the full address block (may contain newlines / Chinese). Same house pattern as the other Settings
-- lists (0055/0066): GLOBAL rows only (user_id NULL), is_allowed_user RLS, getCnAddresses degrades to []
-- until this is applied. Idempotent.

create table if not exists public.settings_cn_addresses (
  id          bigint generated always as identity primary key,
  user_id     text,                          -- NULL = global default
  label       text    not null,              -- 'MTE', 'Andrio (Balikpapan)', …
  address     text    not null default '',   -- the full name & address block (newlines allowed)
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists settings_cn_addresses_user_sort_idx on public.settings_cn_addresses (user_id, sort_order);

alter table public.settings_cn_addresses enable row level security;
drop policy if exists "settings_cn_addresses_all" on public.settings_cn_addresses;
create policy "settings_cn_addresses_all" on public.settings_cn_addresses
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());
grant select, insert, update, delete on public.settings_cn_addresses to authenticated, service_role;

-- seed the current shipper (MTE) + consignee once, so the pickers aren't empty on first use (re-runnable).
insert into public.settings_cn_addresses (user_id, label, address, sort_order)
select null, v.label, v.address, v.ord
from (values
  ('MTE', '广东省惠州惠城区水口街道东江高新科技产业园兴运东路1号鼎晟盛威智慧科技园3栋4楼', 0),
  ('Andrio (Balikpapan)', E'Andrio Suroyo\nGrand City cluster Pineville L3/28, Kel. Graha Indah, Kec. Balikpapan Utara, Kota Balikpapan 76126\n0812-6000-2889', 1)
) as v(label, address, ord)
where not exists (select 1 from public.settings_cn_addresses a where a.user_id is null);

notify pgrst, 'reload schema';
