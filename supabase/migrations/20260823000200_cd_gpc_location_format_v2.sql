-- CD-GPC: normaliza ubicaciones estructuradas y permite lineales como A, L4 o L12.
-- Los espacios y los apostrofes rectos/curvos se convierten antes de validar.
create or replace function public.validate_cd_gpc_location_format()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    store_name text;
    normalized_location text;
begin
    if new.store_id is null then
        return new;
    end if;

    select upper(trim(coalesce(s.name, s.erp_sede, '')))
      into store_name
      from public.stores s
     where s.id = new.store_id;

    if store_name = 'CD-GPC' then
        normalized_location := upper(trim(coalesce(new.location, '')));
        normalized_location := replace(replace(replace(replace(normalized_location, '’', '-'), '‘', '-'), '''', '-'), '`', '-');
        normalized_location := regexp_replace(normalized_location, '\s+', '', 'g');
        new.location := normalized_location;
        if new.location !~ '^[0-9]{2}-[A-Z][0-9]{0,2}-[0-9]{2}-[0-9]{2}$' then
            raise exception 'Ubicacion invalida para CD-GPC: %. Use el formato 01-A-01-01 o 06-L4-01-01.', new.location;
        end if;
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

-- Corrige registros activos que se vuelven validos al compactar espacios y
-- convertir apostrofes. Si ya existe el registro canonico, se conserva ese
-- registro y se desactiva el duplicado historico para no perder inventario.
with normalized as (
    select pl.id,
           upper(trim(coalesce(pl.location, ''))) as original_location,
           regexp_replace(
               replace(replace(replace(replace(upper(trim(coalesce(pl.location, ''))), '’', '-'), '‘', '-'), '''', '-'), '`', '-'),
               '\s+', '', 'g'
           ) as normalized_location
      from public.product_locations pl
     where pl.store_id = (select s.id from public.stores s where upper(trim(coalesce(s.name, s.erp_sede, ''))) = 'CD-GPC' limit 1)
       and pl.is_active = true
), duplicates as (
    select n.id
      from normalized n
      join public.product_locations canonical
        on canonical.store_id = (select s.id from public.stores s where upper(trim(coalesce(s.name, s.erp_sede, ''))) = 'CD-GPC' limit 1)
       and canonical.id <> n.id
       and canonical.is_active = true
       and canonical.location = n.normalized_location
     where n.original_location <> n.normalized_location
       and n.normalized_location ~ '^[0-9]{2}-[A-Z][0-9]{0,2}-[0-9]{2}-[0-9]{2}$'
)
update public.product_locations pl
   set is_active = false,
       updated_at = now()
 where pl.id in (select id from duplicates);

with normalized as (
    select pl.id,
           regexp_replace(
               replace(replace(replace(replace(upper(trim(coalesce(pl.location, ''))), '’', '-'), '‘', '-'), '''', '-'), '`', '-'),
               '\s+', '', 'g'
           ) as normalized_location
      from public.product_locations pl
     where pl.store_id = (select s.id from public.stores s where upper(trim(coalesce(s.name, s.erp_sede, ''))) = 'CD-GPC' limit 1)
       and pl.location is not null
), candidates as (
    select n.id, n.normalized_location
      from normalized n
     where n.normalized_location ~ '^[0-9]{2}-[A-Z][0-9]{0,2}-[0-9]{2}-[0-9]{2}$'
       and not exists (
           select 1
             from public.product_locations other
            where other.id <> n.id
              and other.store_id = (select s.id from public.stores s where upper(trim(coalesce(s.name, s.erp_sede, ''))) = 'CD-GPC' limit 1)
              and other.location = n.normalized_location
       )
)
update public.product_locations pl
   set location = candidates.normalized_location,
       updated_at = now()
  from candidates
 where pl.id = candidates.id
   and pl.location is distinct from candidates.normalized_location;

notify pgrst, 'reload schema';
