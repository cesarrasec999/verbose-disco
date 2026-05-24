-- Permite guardar varias ubicaciones/cantidades en una misma validacion.
-- Seguro para datos existentes: solo quita la restriccion de una sola linea por validacion.

alter table if exists public.general_inventory_validation_counts
  drop constraint if exists general_inventory_validation_counts_validation_item_id_key;

create index if not exists idx_gi_validation_counts_item
  on public.general_inventory_validation_counts(validation_item_id);

