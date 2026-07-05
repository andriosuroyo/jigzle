-- 0058 — manual image URLs for the Catalogue item editor (PR189).
-- Additive and non-destructive: a nullable text[] on catalogue holding up to 5 Google-Drive image URLs
-- (ordered; the first is the primary). The item editor's Media tab writes it. Display: when a SKU has
-- image_urls they drive the hero + gallery; otherwise the existing sku_images pipeline image is used.
-- The 5-item cap is enforced in the app; a light DB guard keeps rogue writes bounded.

alter table public.catalogue
  add column if not exists image_urls text[];

alter table public.catalogue
  drop constraint if exists catalogue_image_urls_max5;
alter table public.catalogue
  add constraint catalogue_image_urls_max5
  check (image_urls is null or array_length(image_urls, 1) is null or array_length(image_urls, 1) <= 5);
