-- Phase 1 — SKU images, Stage 1 (PR-A): the serving model (docs/011). DISPLAY-ONLY.
-- Goal: resolve item_code → image in ONE fast read, never by scanning Google Drive at query time.
-- Supabase Storage holds only a single ~400px display.webp per SKU (Free 1 GB tier); originals
-- stay in Drive as cold archive. This migration adds the model + the read view + a reconciliation
-- table; the bootstrap importer (scripts/import/import_images.py, run on Andrio's Mac) populates it.
--
-- Idempotent / re-runnable (guarded enum + if-not-exists everywhere), exactly like 0020. Keeps the
-- legacy catalogue.image / has_image columns (a later cleanup migration drops them). Does NOT touch
-- barcodes, stock_check, the importer, or any RPC.

-- ============== enum image_status ==============
do $$
begin
  if not exists (select 1 from pg_type where typname = 'image_status') then
    create type public.image_status as enum ('has_image', 'not_found', 'pending');
  end if;
end $$;

-- ============== table sku_images — one row per physical candidate file we know of ==============
create table if not exists public.sku_images (
  id            uuid primary key default gen_random_uuid(),
  item_code     text not null references public.catalogue(item_code) on delete cascade,
  source        text not null check (source in ('edited', 'pre')),  -- B = edited, A = pre
  variant       text not null,            -- suffix as found: '_edit', '_0', '_1', …
  source_path   text not null,            -- provenance: Drive-relative path of the original (NOT in the bucket)
  display_path  text,                     -- bucket path of the generated ~400px display.webp (primary only)
  width         integer,
  height        integer,
  bytes         integer,
  content_hash  text,                     -- sha256 of original bytes → skip re-upload on re-run
  is_primary    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (item_code, source, variant)     -- one row per (SKU, A/B, suffix)
);

create index if not exists sku_images_item_code_idx on public.sku_images (item_code);
-- exactly one primary per SKU
create unique index if not exists sku_images_one_primary on public.sku_images (item_code) where is_primary;

-- ============== catalogue additions (additive; image / has_image kept for now) ==============
alter table public.catalogue
  add column if not exists image_status public.image_status not null default 'pending';
alter table public.catalogue
  add column if not exists primary_image_id uuid references public.sku_images(id);

-- ============== view sku_image_resolved — the app's ONLY image read ==============
-- security_invoker so the querying user's RLS on catalogue / sku_images applies. Returns the
-- display_path only (the original is never exposed); the app builds the public CDN URL from it.
create or replace view public.sku_image_resolved
  with (security_invoker = true)
as
select c.item_code,
       c.image_status,
       i.display_path
from public.catalogue c
left join public.sku_images i on i.id = c.primary_image_id;

-- ============== reconciliation table image_orphans (drives Stage-2 attach; importer fills it) ==============
create table if not exists public.image_orphans (
  id                  uuid primary key default gen_random_uuid(),
  orphan_path         text not null,
  source              text,
  variant             text,
  suggested_item_code text,
  score               numeric,
  status              text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists image_orphans_status_idx on public.image_orphans (status);
-- one row per orphan file path → lets the importer re-run idempotently (on_conflict do nothing)
create unique index if not exists image_orphans_path_idx on public.image_orphans (orphan_path);

-- ============== RLS — mirror catalogue's per-table policy (the is_allowed_user JWT pattern) ==============
alter table public.sku_images    enable row level security;
alter table public.image_orphans enable row level security;

drop policy if exists "sku_images_all" on public.sku_images;
create policy "sku_images_all" on public.sku_images
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

drop policy if exists "image_orphans_all" on public.image_orphans;
create policy "image_orphans_all" on public.image_orphans
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

-- New entities are not auto-exposed (supabase/config.toml) — grant explicitly. RLS still gates rows;
-- the security_invoker view needs the operator to hold SELECT on its base tables. Never anon.
grant select, insert, update, delete on public.sku_images    to authenticated, service_role;
grant select, insert, update, delete on public.image_orphans to authenticated, service_role;
grant select on public.sku_image_resolved to authenticated, service_role;

-- ============== storage bucket: sku-images (public-read) ==============
-- The ONLY object stored per SKU is sku-images/{item_code}/display.webp. Writes via service-role
-- (importer) + the future Stage-2 RPC; public read (catalogue images aren't secret).
insert into storage.buckets (id, name, public)
values ('sku-images', 'sku-images', true)
on conflict (id) do nothing;
