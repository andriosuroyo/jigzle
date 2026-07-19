-- 0108 — PR387: track the health of a SKU's manually-entered Google-Drive image links.
-- A SKU can have image_urls (Drive share links) but no canonical bucket image; those links render live via
-- the thumbnail fallback (PR363) yet still count as "missing image" and nothing flags a dead link. This
-- column records the result of the in-app "Validate Drive links" pass:
--   'ok'     — at least one link fetched a real image → treat the SKU as having an image
--   'broken' — the SKU has links but none returned an image → surface in the "Broken image links" Fix list
--   null     — no links, or not yet validated
-- Re-running the validation recomputes it, so a fixed/removed link clears 'broken' on the next pass.
-- Additive & idempotent; the app degrades (no exclusion / empty list) until this is applied.

alter table public.catalogue add column if not exists image_link_state text;

-- the "Broken image links" Fix list reads only the broken rows — a tiny partial index keeps it instant.
create index if not exists catalogue_image_link_broken_idx
  on public.catalogue (item_code) where image_link_state = 'broken';
