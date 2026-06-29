-- 0046 — settings_customer_channels: a Settings-managed pick-list of customer contact channels
-- (WhatsApp / Instagram / Shopee / …), each with a brand icon. Mirrors the other settings_* lists
-- (0035 common_notes + the later `icon` column): NULL user_id = global default, sort_order, is_active,
-- RLS via is_allowed_user(). The Customer detail's Channels picker reads this list and shows the icon
-- next to each chosen platform. Additive/safe.

create table if not exists public.settings_customer_channels (
  id          bigint generated always as identity primary key,
  user_id     text,                          -- NULL = global default (this PR writes only NULL)
  label       text    not null,              -- the platform name, e.g. 'WhatsApp', 'Shopee'
  icon        text,                          -- emoji OR an icon URL/path (e.g. '/icons/channels/whatsapp.svg')
  is_active   boolean not null default true,
  sort_order  int     not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists settings_customer_channels_user_sort_idx
  on public.settings_customer_channels (user_id, sort_order);

alter table public.settings_customer_channels enable row level security;
drop policy if exists "settings_customer_channels_all" on public.settings_customer_channels;
create policy "settings_customer_channels_all" on public.settings_customer_channels
  for all using (public.is_allowed_user()) with check (public.is_allowed_user());

-- seed the default channels (global rows; idempotent — guarded by NOT EXISTS on the label). Social
-- media first, then Marketplace. Brand SVGs live in apps/ops/public/icons/channels/; Tokopedia and
-- Lazada have no simple-icons glyph, so they fall back to an emoji.
insert into public.settings_customer_channels (user_id, label, icon, sort_order)
select null, v.label, v.icon, v.ord
from (values
  ('WhatsApp',    '/icons/channels/whatsapp.svg',  0),
  ('Instagram',   '/icons/channels/instagram.svg', 1),
  ('LINE',        '/icons/channels/line.svg',      2),
  ('Facebook',    '/icons/channels/facebook.svg',  3),
  ('TikTok',      '/icons/channels/tiktok.svg',    4),
  ('Telegram',    '/icons/channels/telegram.svg',  5),
  ('Shopee',      '/icons/channels/shopee.svg',    6),
  ('Tokopedia',   '🟢',                            7),
  ('Lazada',      '🔵',                            8),
  ('Blibli',      '/icons/channels/blibli.svg',    9),
  ('TikTok Shop', '/icons/channels/tiktok.svg',    10),
  ('Bukalapak',   '/icons/channels/bukalapak.svg', 11)
) as v(label, icon, ord)
where not exists (
  select 1 from public.settings_customer_channels c
  where c.user_id is null and c.label = v.label
);
