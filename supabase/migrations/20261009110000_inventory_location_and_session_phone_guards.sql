-- Protect the active inventory flow at the database boundary.
-- 1. Every location stored by web/PWA/APK replaces quote-like separators with "-".
-- 2. A phone can be linked only once inside the same inventory session.
--
-- Existing count/history rows are intentionally not rewritten. Open-session master
-- locations are normalized only after a collision preflight, so no row is merged
-- or deleted.

create or replace function public.normalize_general_inventory_location_code(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $function$
  select upper(
    btrim(
      replace(
        translate(coalesce(p_value, ''), chr(39) || '’‘´`', '-----'),
        chr(160),
        ' '
      )
    )
  );
$function$;

create or replace function public.normalize_general_inventory_phone(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, public
as $function$
  select regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g');
$function$;

do $preflight$
begin
  if exists (
    select 1
    from public.general_inventory_locations gil
    join public.general_inventory_sessions gis on gis.id = gil.session_id
    where gis.status in ('open', 'frozen')
    group by gil.session_id, public.normalize_general_inventory_location_code(gil.location_code)
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'No se normalizaron ubicaciones: una sesion activa contiene codigos que colisionarian.';
  end if;

  if exists (
    select 1
    from public.general_inventory_session_operators giso
    join public.general_inventory_operators gio on gio.id = giso.operator_id
    group by giso.session_id, public.normalize_general_inventory_phone(gio.phone)
    having public.normalize_general_inventory_phone(gio.phone) <> '' and count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'No se activo la restriccion: ya existen celulares duplicados dentro de una sesion.';
  end if;
end;
$preflight$;

update public.general_inventory_locations gil
set
  location_code = public.normalize_general_inventory_location_code(gil.location_code),
  ticket = case
    when gil.ticket is null then null
    else public.normalize_general_inventory_location_code(gil.ticket)
  end
from public.general_inventory_sessions gis
where gis.id = gil.session_id
  and gis.status in ('open', 'frozen')
  and (
    gil.location_code is distinct from public.normalize_general_inventory_location_code(gil.location_code)
    or gil.ticket is distinct from case
      when gil.ticket is null then null
      else public.normalize_general_inventory_location_code(gil.ticket)
    end
  );

create or replace function public.guard_general_inventory_location_code()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  new.location_code := public.normalize_general_inventory_location_code(new.location_code);
  if new.location_code = '' then
    raise exception using
      errcode = '23514',
      message = 'La ubicacion no puede quedar vacia.';
  end if;
  return new;
end;
$function$;

create or replace function public.guard_general_inventory_master_location()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  new.location_code := public.normalize_general_inventory_location_code(new.location_code);
  if new.location_code = '' then
    raise exception using
      errcode = '23514',
      message = 'La ubicacion no puede quedar vacia.';
  end if;
  if new.ticket is not null then
    new.ticket := public.normalize_general_inventory_location_code(new.ticket);
  end if;
  return new;
end;
$function$;

drop trigger if exists general_inventory_locations_normalize_code on public.general_inventory_locations;
create trigger general_inventory_locations_normalize_code
before insert or update of location_code, ticket
on public.general_inventory_locations
for each row execute function public.guard_general_inventory_master_location();

drop trigger if exists general_inventory_counts_normalize_location on public.general_inventory_counts;
create trigger general_inventory_counts_normalize_location
before insert or update of location_code
on public.general_inventory_counts
for each row execute function public.guard_general_inventory_location_code();

drop trigger if exists general_inventory_recount_counts_normalize_location on public.general_inventory_recount_counts;
create trigger general_inventory_recount_counts_normalize_location
before insert or update of location_code
on public.general_inventory_recount_counts
for each row execute function public.guard_general_inventory_location_code();

drop trigger if exists general_inventory_validation_counts_normalize_location on public.general_inventory_validation_counts;
create trigger general_inventory_validation_counts_normalize_location
before insert or update of location_code
on public.general_inventory_validation_counts
for each row execute function public.guard_general_inventory_location_code();

create or replace function public.guard_general_inventory_operator_phone()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
begin
  new.phone := public.normalize_general_inventory_phone(new.phone);
  if char_length(new.phone) < 8 then
    raise exception using
      errcode = '23514',
      message = 'El celular del usuario debe contener al menos 8 digitos.';
  end if;

  if tg_op = 'UPDATE' and new.phone is distinct from old.phone then
    -- Lock the affected sessions in a stable order. This also closes the race
    -- between editing a phone and registering another operator concurrently.
    perform gis.id
    from public.general_inventory_sessions gis
    where exists (
      select 1
      from public.general_inventory_session_operators own_link
      where own_link.session_id = gis.id
        and own_link.operator_id = old.id
    )
    order by gis.id
    for update;

    if exists (
      select 1
      from public.general_inventory_session_operators own_link
      join public.general_inventory_session_operators other_link
        on other_link.session_id = own_link.session_id
       and other_link.operator_id <> old.id
      join public.general_inventory_operators other_operator
        on other_operator.id = other_link.operator_id
      where own_link.operator_id = old.id
        and public.normalize_general_inventory_phone(other_operator.phone) = new.phone
    ) then
      raise exception using
        errcode = '23505',
        message = 'Este celular ya pertenece a otro usuario dentro de una de sus sesiones de inventario.';
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists general_inventory_operators_guard_phone on public.general_inventory_operators;
create trigger general_inventory_operators_guard_phone
before insert or update of phone
on public.general_inventory_operators
for each row execute function public.guard_general_inventory_operator_phone();

create or replace function public.guard_general_inventory_session_phone()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  v_phone text;
begin
  -- Registration is infrequent; locking the parent session makes the
  -- cross-table uniqueness check safe even under simultaneous registrations.
  perform gis.id
  from public.general_inventory_sessions gis
  where gis.id = new.session_id
  for update;

  select public.normalize_general_inventory_phone(gio.phone)
  into v_phone
  from public.general_inventory_operators gio
  where gio.id = new.operator_id;

  if coalesce(v_phone, '') = '' then
    raise exception using
      errcode = '23514',
      message = 'El usuario no tiene un celular valido.';
  end if;

  if exists (
    select 1
    from public.general_inventory_session_operators other_link
    join public.general_inventory_operators other_operator
      on other_operator.id = other_link.operator_id
    where other_link.session_id = new.session_id
      and other_link.operator_id <> new.operator_id
      and public.normalize_general_inventory_phone(other_operator.phone) = v_phone
  ) then
    raise exception using
      errcode = '23505',
      message = 'Este celular ya esta registrado por otro usuario en esta sesion de inventario.';
  end if;

  return new;
end;
$function$;

drop trigger if exists general_inventory_session_operators_guard_phone
  on public.general_inventory_session_operators;
create trigger general_inventory_session_operators_guard_phone
before insert or update of session_id, operator_id
on public.general_inventory_session_operators
for each row execute function public.guard_general_inventory_session_phone();

revoke all on function public.normalize_general_inventory_location_code(text) from public;
revoke all on function public.normalize_general_inventory_phone(text) from public;
revoke all on function public.guard_general_inventory_location_code() from public;
revoke all on function public.guard_general_inventory_master_location() from public;
revoke all on function public.guard_general_inventory_operator_phone() from public;
revoke all on function public.guard_general_inventory_session_phone() from public;

