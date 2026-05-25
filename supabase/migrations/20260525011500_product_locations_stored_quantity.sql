-- Campo opcional para registrar la cantidad ubicada/almacenada.
-- Es aditivo: no borra ni modifica ubicaciones existentes.
alter table public.product_locations
    add column if not exists stored_quantity numeric;
