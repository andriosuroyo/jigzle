-- PR84 — Settings icons: an optional per-row icon for every settings pick-list. The `icon` column
-- holds EITHER a short emoji (e.g. '🏦') OR a public Storage URL for an uploaded image; the UI renders
-- an <img> when it looks like a URL, otherwise the text/emoji. Uploaded images live in a new public
-- bucket `settings-icons` (read by plain public URL, like sku-images; writes RLS-gated to allowed users).

-- ── icon column on each generic settings list (nullable; null = no icon) ──
alter table public.settings_payment_methods  add column if not exists icon text;
alter table public.settings_courier_services add column if not exists icon text;
alter table public.settings_box_presets      add column if not exists icon text;
alter table public.settings_inbound_labels   add column if not exists icon text;
alter table public.settings_common_notes     add column if not exists icon text;

-- ── storage bucket for uploaded icons (public-read, like sku-images) ──
insert into storage.buckets (id, name, public)
values ('settings-icons', 'settings-icons', true)
on conflict (id) do nothing;

-- ── storage RLS: anyone may read (public bucket); only allowed users may write/replace/remove ──
drop policy if exists "settings_icons_read"   on storage.objects;
create policy "settings_icons_read" on storage.objects
  for select using (bucket_id = 'settings-icons');

drop policy if exists "settings_icons_insert" on storage.objects;
create policy "settings_icons_insert" on storage.objects
  for insert with check (bucket_id = 'settings-icons' and public.is_allowed_user());

drop policy if exists "settings_icons_update" on storage.objects;
create policy "settings_icons_update" on storage.objects
  for update using (bucket_id = 'settings-icons' and public.is_allowed_user())
  with check (bucket_id = 'settings-icons' and public.is_allowed_user());

drop policy if exists "settings_icons_delete" on storage.objects;
create policy "settings_icons_delete" on storage.objects
  for delete using (bucket_id = 'settings-icons' and public.is_allowed_user());
