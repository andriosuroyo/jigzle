-- PR28 — SETTINGS 4th list: settings_inbound_labels, the per-line Inbound label pick-list.
--   Same shape + RLS + seed pattern as the three lists in 0028. The Inbound receive screen's
--   per-line `label` dropdown (was a hardcoded ['Exclude','Hold','Tokopedia']) now reads this
--   global, editable list. The label stored on an `inbound` row is copied TEXT (no FK), so old
--   rows that already hold 'Exclude' still render — the value is data, not a reference.
--
-- NOTE the deliberate omission: 'Exclude' is NOT seeded. Receiving has a dedicated exclude
--   checkbox + qty + reason now, so a label literally called "Exclude" is redundant/confusing.

-- ============== inbound labels ==============
create table if not exists public.settings_inbound_labels (
  id          bigint generated always as identity primary key,
  user_id     text,                          -- NULL = global default (this PR writes only NULL)
  label       text    not null,              -- e.g. 'Hold', 'Tokopedia'
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now()
);

-- ── index: the (user_id, sort_order) btree serves the NULL-only ordered read path ──
create index if not exists settings_inbound_labels_user_sort_idx on public.settings_inbound_labels (user_id, sort_order);

-- ============== RLS ==============
alter table public.settings_inbound_labels enable row level security;

drop policy if exists "settings_inbound_labels_all" on public.settings_inbound_labels;
create policy "settings_inbound_labels_all" on public.settings_inbound_labels
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

-- ============== seed (global rows, user_id = NULL; idempotent — guarded by NOT EXISTS) ==============
-- Hold + Tokopedia only (Exclude intentionally dropped — see header). Re-running never duplicates.
insert into public.settings_inbound_labels (user_id, label, sort_order)
select null, v.label, v.ord
from (values
  ('Hold',       0),
  ('Tokopedia',  1)
) as v(label, ord)
where not exists (
  select 1 from public.settings_inbound_labels l
  where l.user_id is null and l.label = v.label
);
