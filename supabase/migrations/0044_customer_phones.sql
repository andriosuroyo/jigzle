-- PR95 — Customers can hold up to three phone numbers. The primary `phone` stays the dedup/search key
-- (unchanged); phone2 / phone3 are secondary contacts. Each keeps a normalized form + the raw input,
-- mirroring phone / phone_raw (0004).

alter table public.customers add column if not exists phone2 text;
alter table public.customers add column if not exists phone2_raw text;
alter table public.customers add column if not exists phone3 text;
alter table public.customers add column if not exists phone3_raw text;
