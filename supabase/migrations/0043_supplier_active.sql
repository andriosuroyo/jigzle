-- PR89 — Suppliers: soft delete. "Removing" a supplier in Settings must never touch historical POs
-- (which keep their supplier_id and resolve the supplier's name straight from this table). So instead
-- of a hard delete (blocked by the FK once any PO references it), we hide the row: is_active = false.
-- getSuppliers reads only active rows, so a removed supplier drops out of the picker + the settings
-- list, while every historical PO still shows its supplier name unchanged.

alter table public.suppliers add column if not exists is_active boolean not null default true;
create index if not exists suppliers_active_sort_idx on public.suppliers (is_active, sort_order, name);
