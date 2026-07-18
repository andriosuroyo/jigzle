-- 0104 — PR379: optional brand logo. A per-brand image URL shown in Catalog → Browse (the brand rows)
-- in place of the generated monogram fallback. Set in Settings → Catalog → Brand logos. Paste any
-- reachable image URL (Supabase Storage, a CDN, the brand's own site). Nullable; the app falls back to
-- the monogram whenever it's empty or the image fails to load. Writes are gated by the existing
-- brands_all RLS policy (is_allowed_user). Idempotent.

alter table public.brands add column if not exists logo_url text;
