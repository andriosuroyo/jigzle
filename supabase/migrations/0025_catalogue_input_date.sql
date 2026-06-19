-- PR18 — catalogue.input_date: when a SKU was first entered into the system, so admins can spot the
-- most recently-added SKUs (especially the partial ones created via Stock Check quick-add).
--
-- created_at already exists, but it records the importer's insert time across many runs; input_date
-- is a clean, business-meaningful "first entered" marker the team controls. Legacy/imported rows get
-- a single marker date (when the catalog was loaded / this system started); every NEW row (quick-add,
-- receive-time stub, importer re-run) gets its insert date automatically via the column default.
--
-- Re-runnable: add-if-not-exists, then backfill ONLY the nulls (so a re-run never overwrites a real
-- quick-add date), then set the default. (Order matters: add WITHOUT a default first so existing rows
-- land as NULL and the backfill — not the default — decides their value.)

alter table public.catalogue add column if not exists input_date date;

-- legacy rows (added before this column): mark them with the catalog-load / system-start date.
update public.catalogue set input_date = date '2026-06-18' where input_date is null;

-- future inserts get the day they were entered.
alter table public.catalogue alter column input_date set default current_date;

create index if not exists catalogue_input_date_idx on public.catalogue (input_date);
