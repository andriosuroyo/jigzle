-- 0119 — Calculator (PR397): give each shipping method a country flag (shown in the picker instead of
-- the country name) and a per-method import tax rate (moved out of the Calculator into Settings).
-- Additive & idempotent.

alter table public.shipping_methods add column if not exists flag text;
alter table public.shipping_methods add column if not exists import_tax_rate numeric;

-- seed the flag from the source country (only where still null, so manual edits survive re-runs)
update public.shipping_methods set flag = m.flag
from (values
  ('China', '🇨🇳'), ('Japan', '🇯🇵'), ('Taiwan', '🇹🇼'), ('Hong Kong', '🇭🇰'),
  ('Korea', '🇰🇷'), ('South Korea', '🇰🇷'), ('United States', '🇺🇸'), ('USA', '🇺🇸'),
  ('Europe', '🇪🇺'), ('United Kingdom', '🇬🇧'), ('UK', '🇬🇧'), ('Indonesia', '🇮🇩')
) as m(country, flag)
where public.shipping_methods.flag is null and public.shipping_methods.source_country = m.country;

-- seed the import tax rate to the app's long-standing 18.25% default (only where still null)
update public.shipping_methods set import_tax_rate = 18.25 where import_tax_rate is null;
