-- Historial inmutable de cambios al maestro de ubicaciones.
-- Registra altas, ediciones, eliminaciones lógicas y reactivaciones,
-- incluidos los cambios hechos mediante carga Excel o procesos masivos.
create table if not exists public.product_location_history (
    id uuid primary key default gen_random_uuid(),
    location_id uuid,
    store_id uuid,
    store_name text,
    product_id uuid,
    sku text,
    product_description text,
    unit text,
    location text,
    stored_quantity numeric,
    is_active boolean,
    action text not null check (action in ('created', 'updated', 'deleted', 'restored', 'baseline')),
    previous_location text,
    previous_stored_quantity numeric,
    previous_is_active boolean,
    actor_user_id uuid references public.cyclic_users(id) on delete set null,
    source text,
    occurred_at timestamptz not null default now()
);

create index if not exists product_location_history_store_occurred_idx
    on public.product_location_history (store_id, occurred_at desc);

create index if not exists product_location_history_product_occurred_idx
    on public.product_location_history (product_id, occurred_at desc);

create or replace function public.log_product_location_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    current_row public.product_locations%rowtype;
    prior_row public.product_locations%rowtype;
    action_name text;
    product_description_value text;
    product_unit_value text;
    store_name_value text;
begin
    if tg_op = 'DELETE' then
        prior_row := old;
        current_row := old;
        action_name := 'deleted';
    else
        current_row := new;
        if tg_op = 'INSERT' then
            action_name := 'created';
        elsif old.is_active and not new.is_active then
            action_name := 'deleted';
            prior_row := old;
        elsif not old.is_active and new.is_active then
            action_name := 'restored';
            prior_row := old;
        else
            action_name := 'updated';
            prior_row := old;
        end if;
    end if;

    select p.description, p.unit
      into product_description_value, product_unit_value
      from public.cyclic_products p
     where p.id = current_row.product_id;

    select s.name
      into store_name_value
      from public.stores s
     where s.id = current_row.store_id;

    insert into public.product_location_history (
        location_id, store_id, store_name, product_id, sku,
        product_description, unit, location, stored_quantity, is_active,
        action, previous_location, previous_stored_quantity, previous_is_active,
        actor_user_id, source, occurred_at
    ) values (
        current_row.id, current_row.store_id, coalesce(store_name_value, 'Global'), current_row.product_id, current_row.sku,
        product_description_value, product_unit_value, current_row.location, current_row.stored_quantity, current_row.is_active,
        action_name, prior_row.location, prior_row.stored_quantity, prior_row.is_active,
        current_row.updated_by, coalesce(current_row.last_source, 'Recepcion'), coalesce(current_row.updated_at, now())
    );

    if tg_op = 'DELETE' then
        return old;
    end if;
    return new;
end;
$$;

drop trigger if exists product_locations_history_trigger on public.product_locations;
create trigger product_locations_history_trigger
after insert or update or delete on public.product_locations
for each row execute function public.log_product_location_history();

-- Punto de partida para que la primera descarga también incluya el maestro ya existente.
-- Los eventos previos a esta migración no pueden reconstruirse retroactivamente.
insert into public.product_location_history (
    location_id, store_id, store_name, product_id, sku,
    product_description, unit, location, stored_quantity, is_active,
    action, actor_user_id, source, occurred_at
)
select
    pl.id, pl.store_id, coalesce(s.name, 'Global'), pl.product_id, pl.sku,
    p.description, p.unit, pl.location, pl.stored_quantity, pl.is_active,
    'baseline', pl.updated_by, coalesce(pl.last_source, 'Recepcion'), coalesce(pl.updated_at, pl.created_at, now())
from public.product_locations pl
left join public.cyclic_products p on p.id = pl.product_id
left join public.stores s on s.id = pl.store_id
where not exists (select 1 from public.product_location_history);

grant select on public.product_location_history to anon, authenticated;

notify pgrst, 'reload schema';
