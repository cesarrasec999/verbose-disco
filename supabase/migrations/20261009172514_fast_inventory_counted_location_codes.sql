-- La preparación solo necesita saber qué ubicaciones ya fueron contadas.
-- Evita descargar miles de registros completos en cada actualización realtime.
create or replace function public.get_general_inventory_counted_location_codes(p_session_id uuid)
returns table(location_code text)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct c.location_code
  from public.general_inventory_counts c
  where c.session_id = p_session_id
    and c.location_code is not null
    and btrim(c.location_code) <> ''
  order by c.location_code;
$$;

revoke all on function public.get_general_inventory_counted_location_codes(uuid) from public;
grant execute on function public.get_general_inventory_counted_location_codes(uuid) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
