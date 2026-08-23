-- CD-GPC usa ubicaciones estructuradas: 01-A-01-01.
-- Las ubicaciones historicas no se borran; el filtro de la aplicacion permite
-- encontrarlas y corregirlas. Este trigger bloquea nuevos registros invalidos.
create or replace function public.validate_cd_gpc_location_format()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    store_name text;
begin
    if new.store_id is null then
        return new;
    end if;

    select upper(trim(coalesce(s.name, s.erp_sede, '')))
      into store_name
      from public.stores s
     where s.id = new.store_id;

    if store_name = 'CD-GPC' and new.location !~ '^[0-9]{2}-[A-Z]-[0-9]{2}-[0-9]{2}$' then
        raise exception 'Ubicacion invalida para CD-GPC: %. Use el formato 01-A-01-01.', new.location;
    end if;
    return new;
end;
$$;

drop trigger if exists validate_cd_gpc_product_location on public.product_locations;
create trigger validate_cd_gpc_product_location
before insert or update of store_id, location on public.product_locations
for each row execute function public.validate_cd_gpc_location_format();

drop trigger if exists validate_cd_gpc_operator_location on public.product_location_operator_records;
create trigger validate_cd_gpc_operator_location
before insert or update of store_id, location on public.product_location_operator_records
for each row execute function public.validate_cd_gpc_location_format();

notify pgrst, 'reload schema';
