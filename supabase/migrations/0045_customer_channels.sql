-- PR97 — Customer channels: where a customer reaches us. Up to three { platform, handle } entries
-- (e.g. WhatsApp / Instagram / Shopee), stored as a small jsonb array. Replaces the single legacy
-- `channel` text in the UI (the old channel / channel_raw / ig_handle columns are kept, untouched).

alter table public.customers add column if not exists channels jsonb not null default '[]'::jsonb;
