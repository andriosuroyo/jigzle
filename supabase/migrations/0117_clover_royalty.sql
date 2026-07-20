-- 0117 — Clover Royalty (PR392). Two new managed tables behind the Clover Royalty screen + its Settings
-- sub-editor. The royalty LEDGER already exists (royalty_paid, 0008) — this adds the per-entity rate
-- schedule and the managed entity list, and normalises the stray artist variant. Additive & idempotent.

-- ── managed royalty entities (Voila Arts, Mentol Art) — mirror catalogue.artist / royalty_paid.partner ──
create table if not exists public.royalty_entities (
  id          bigint generated always as identity primary key,
  name        text    not null unique,
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now()
);
alter table public.royalty_entities enable row level security;
drop policy if exists "royalty_entities_all" on public.royalty_entities;
create policy "royalty_entities_all" on public.royalty_entities
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

-- ── per-entity rate schedule: one row per (entity, piece count) → royalty in FULL IDR ──
create table if not exists public.royalty_rate_rows (
  id          bigint generated always as identity primary key,
  entity      text   not null,
  pieces      int    not null,
  royalty_idr bigint not null default 0,
  created_at  timestamptz not null default now(),
  unique (entity, pieces)
);
create index if not exists royalty_rate_rows_entity_idx on public.royalty_rate_rows (entity);
alter table public.royalty_rate_rows enable row level security;
drop policy if exists "royalty_rate_rows_all" on public.royalty_rate_rows;
create policy "royalty_rate_rows_all" on public.royalty_rate_rows
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

grant select, insert, update, delete on public.royalty_entities to authenticated, service_role;
grant select, insert, update, delete on public.royalty_rate_rows to authenticated, service_role;

-- ── normalise the stray artist variant so the artist→entity match is clean (PR392) ──
update public.catalogue set artist = 'Voila Arts' where artist ilike 'Voila Arts |%';

-- ── seed the two entities ──
insert into public.royalty_entities (name, sort_order)
values ('Voila Arts', 0), ('Mentol Art', 1)
on conflict (name) do nothing;

-- ── seed the rate schedule from actual history: the most common royalty paid per (partner, piece count).
-- Gives a sensible starting grid the operator can then edit. Idempotent (skips any pair already present). ──
insert into public.royalty_rate_rows (entity, pieces, royalty_idr)
select rp.partner, c.piece_count_n,
       mode() within group (order by rp.royalty_idr) as royalty_idr
from public.royalty_paid rp
join public.catalogue c on c.item_code = rp.item_code
where c.piece_count_n is not null and rp.royalty_idr is not null and rp.royalty_idr > 0
group by rp.partner, c.piece_count_n
on conflict (entity, pieces) do nothing;
