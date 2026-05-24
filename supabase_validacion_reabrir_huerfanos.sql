-- Reabre validaciones marcadas como contadas sin lineas guardadas.
-- No borra datos: solo permite que el operario vuelva a guardar la validacion.

update public.general_inventory_validation_items i
set status = 'assigned',
    updated_at = now()
where i.status = 'counted'
  and not exists (
    select 1
    from public.general_inventory_validation_counts c
    where c.validation_item_id = i.id
  );

