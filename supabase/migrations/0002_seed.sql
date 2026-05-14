-- Seed currencies + shipping methods to match the original HTML defaults.

insert into public.currencies (code, name, rate_to_idr, is_base) values
  ('IDR', 'Indonesian Rupiah',        1,        true),
  ('CNY', 'Chinese Yuan',             2706.28,  false),
  ('JPY', 'Japanese Yen',             116.59,   false),
  ('HKD', 'Hong Kong Dollar',         2348.10,  false),
  ('TWD', 'New Taiwan Dollar',        582.84,   false),
  ('KRW', 'South Korean Won',         12.29,    false),
  ('USD', 'United States Dollar',     18381.30, false),
  ('EUR', 'Euro',                     21574.35, false),
  ('GBP', 'British Pound',            24886.18, false)
on conflict (code) do nothing;

insert into public.shipping_methods (id, display, source_country, source_currency, rate_per_kg, rate_currency, warehouse_fee, tax_included, active, sort_order, notes) values
  ('ship-cn-ups',     'China — UPS via 东联 — Air',         'China',          'CNY', 60,     'CNY', 20,  false, true, 10, 'Import tax applies on top.'),
  ('ship-cn-cbl-air', 'China — CBL Forwarder — Air',         'China',          'CNY', 220000, 'IDR', 0,   true,  true, 20, 'All-in: tax included.'),
  ('ship-cn-cbl-sea', 'China — CBL Forwarder — Sea',         'China',          'CNY', 50000,  'IDR', 0,   true,  true, 30, 'All-in. Sea kg-rate (cbm not modeled).'),
  ('ship-cn-mte-air', 'China — MTE Forwarder — Air',         'China',          'CNY', 220000, 'IDR', 0,   true,  true, 40, 'Similar to CBL Air.'),
  ('ship-jp-ems-air', 'Japan — Japan Post EMS — Air',        'Japan',          'JPY', 1300,   'JPY', 0,   false, true, 50, 'Via Imaginatorium.'),
  ('ship-tw-ems-air', 'Taiwan — Taiwan Post EMS — Air',      'Taiwan',         'TWD', 400,    'TWD', 100, false, true, 60, ''),
  ('ship-hk-ems-air', 'Hong Kong — Hong Kong Post — Air',    'Hong Kong',      'HKD', 110,    'HKD', 30,  false, true, 70, ''),
  ('ship-kr-ems-air', 'Korea — Korea Post EMS — Air',        'Korea',          'KRW', 18000,  'KRW', 0,   false, true, 80, ''),
  ('ship-us-air',     'United States — Air',                 'United States',  'USD', 25,     'USD', 0,   false, true, 90, ''),
  ('ship-eu-air',     'Europe — Air',                        'Europe',         'EUR', 27,     'EUR', 0,   false, true, 100, ''),
  ('ship-uk-air',     'United Kingdom — Air',                'United Kingdom', 'GBP', 20,     'GBP', 0,   false, true, 110, '')
on conflict (id) do nothing;
