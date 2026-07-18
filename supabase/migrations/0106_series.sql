-- 0106 — PR386: a dedicated Series for catalogue SKUs + the writer the in-session translation pass uses.
-- The name-retranslation pass (run in-session, like the Opus-vision tagger) decomposes each original
-- name into: franchise + character → already in tags; series → this new `series` column; distinctive
-- title → translate_name (kept concise). `series` is a plain nullable text (like theme/artist): editable
-- in the SKU editor, searchable, and groupable. Additive & idempotent.

alter table public.catalogue add column if not exists series text;

-- writer used by the in-session pass: p is [{ "item_code": "...", "tn": "...", "series": "..." }, ...].
-- tn overwrites translate_name (coalesce keeps the old value if a row is sent without one); series is set
-- as given (null when the product isn't part of a series). SECURITY DEFINER, granted to service_role only
-- (the pass authenticates with the service-role key, like the importers).
create or replace function public.set_translations(p jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  update public.catalogue c
  set translate_name = coalesce(e.tn, c.translate_name),
      series = e.series,
      updated_at = now()
  from jsonb_to_recordset(p) as e(item_code text, tn text, series text)
  where c.item_code = e.item_code;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.set_translations(jsonb) from public, anon, authenticated;
grant execute on function public.set_translations(jsonb) to service_role;

-- extend the fast dropdown-options RPC (0102) so the editor's Series picker offers existing series values,
-- exactly like the other managed lists. create-or-replace with the SAME body + a `series` union line.
create or replace function public.catalog_field_options()
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_object_agg(f, arr), '{}'::jsonb)
  from (
    select f, jsonb_agg(distinct v order by v) as arr
    from (
      select 'product_type' as f, btrim(product_type) as v from public.catalogue where btrim(coalesce(product_type, '')) <> ''
      union all select 'sub_type',   btrim(sub_type)   from public.catalogue where btrim(coalesce(sub_type, ''))   <> ''
      union all select 'piece_type', btrim(piece_type) from public.catalogue where btrim(coalesce(piece_type, '')) <> ''
      union all select 'piece_size', btrim(piece_size) from public.catalogue where btrim(coalesce(piece_size, '')) <> ''
      union all select 'material',   btrim(material)   from public.catalogue where btrim(coalesce(material, ''))   <> ''
      union all select 'effect',     btrim(effect)     from public.catalogue where btrim(coalesce(effect, ''))     <> ''
      union all select 'image_type', btrim(image_type) from public.catalogue where btrim(coalesce(image_type, '')) <> ''
      union all select 'theme',      btrim(theme)      from public.catalogue where btrim(coalesce(theme, ''))      <> ''
      union all select 'series',     btrim(series)     from public.catalogue where btrim(coalesce(series, ''))     <> ''
      union all select 'location',   btrim(location)   from public.catalogue where btrim(coalesce(location, ''))   <> ''
      union all select 'artist',     btrim(artist)     from public.catalogue where btrim(coalesce(artist, ''))     <> ''
    ) s
    group by f
  ) t;
$$;

grant execute on function public.catalog_field_options() to anon, authenticated;
