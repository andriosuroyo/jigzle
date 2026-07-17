-- 0100 — PR372: "Jixelz" is a product LINE/brand, not a form — move it from sub_type to tags.
-- For every SKU whose sub_type is 'Jixelz': append 'Jixelz' to the comma-separated tags (unless already
-- tagged), then clear the sub type, then retire the Settings sub-type row. Idempotent — after it runs no
-- sub_type='Jixelz' remains, so re-running is a no-op.

-- append 'Jixelz' to tags for the Jixelz-sub-type SKUs that don't already carry it
update public.catalogue
set tags = case
    when tags is null or btrim(tags) = '' then 'Jixelz'
    else btrim(tags) || ', Jixelz'
  end
where sub_type = 'Jixelz'
  and (tags is null or lower(tags) not like '%jixelz%');

-- clear the sub type
update public.catalogue set sub_type = null where sub_type = 'Jixelz';

-- retire the Settings sub-type row
update public.settings_catalog_sub_types set is_active = false
where user_id is null and label = 'Jixelz';
