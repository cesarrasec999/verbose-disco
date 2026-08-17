-- Permite corregir el resultado de un codigo en una sesion finalizada sin
-- descongelar la sesion ni tocar el stock de sistema. La operacion es atomica:
-- bloquea la sesion, habilita temporalmente la actualizacion de sus filas,
-- aplica el ajuste y restaura el estado finalizado antes de confirmar.

create table if not exists public.general_inventory_quantity_edits (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.general_inventory_sessions(id) on delete cascade,
  product_id uuid not null references public.cyclic_products(id),
  mode text not null check (mode in ('count', 'recount', 'validation')),
  old_quantity numeric(14,3) not null default 0,
  new_quantity numeric(14,3) not null default 0,
  note text not null,
  editor_id uuid references public.cyclic_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_gi_quantity_edits_session_product
  on public.general_inventory_quantity_edits(session_id, product_id, created_at desc);

create or replace function public.edit_finished_general_inventory_quantity(
  p_editor_id uuid,
  p_session_id uuid,
  p_mode text,
  p_product_id uuid,
  p_new_quantity numeric,
  p_note text,
  p_location_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_editor_id constant uuid := '6640b556-8944-4921-8b13-c547c834fb05';
  v_session public.general_inventory_sessions%rowtype;
  v_count_table text;
  v_item_table text;
  v_item_id_column text;
  v_item_id uuid;
  v_latest_id uuid;
  v_latest_qty numeric := 0;
  v_old_total numeric := 0;
  v_remaining numeric := 0;
  v_next numeric := 0;
  v_take numeric := 0;
  v_row_count integer := 0;
  v_operator_id uuid;
  v_location public.general_inventory_locations%rowtype;
  v_product public.cyclic_products%rowtype;
  v_snapshot public.general_inventory_stock_snapshot%rowtype;
  v_cost numeric := 0;
  v_now timestamptz := now();
  r record;
begin
  if p_editor_id is null or p_editor_id <> v_editor_id then
    raise exception 'Usuario no autorizado para editar sesiones finalizadas';
  end if;
  if p_session_id is null or p_product_id is null then
    raise exception 'Sesion y codigo son obligatorios';
  end if;
  if p_mode not in ('count', 'recount', 'validation') then
    raise exception 'Capa de conteo no valida';
  end if;
  if p_new_quantity is null or p_new_quantity < 0 then
    raise exception 'La cantidad debe ser un numero mayor o igual a cero';
  end if;
  if nullif(trim(coalesce(p_note, '')), '') is null then
    raise exception 'El motivo del ajuste es obligatorio';
  end if;

  select * into v_session
  from public.general_inventory_sessions
  where id = p_session_id
  for update;
  if not found then
    raise exception 'Sesion no encontrada';
  end if;
  if v_session.status <> 'finished' then
    raise exception 'La sesion no esta finalizada';
  end if;

  -- El trigger historico de la instalacion bloquea cambios en hijos cuando la
  -- sesion esta finalizada. Al mantener todo dentro de esta transaccion, el
  -- estado nunca queda expuesto como abierto a otros usuarios.
  update public.general_inventory_sessions
  set status = 'open', updated_at = v_now
  where id = p_session_id;

  if p_mode = 'count' then
    v_count_table := 'general_inventory_counts';
    v_item_table := null;
    v_item_id_column := null;
  elsif p_mode = 'recount' then
    v_count_table := 'general_inventory_recount_counts';
    v_item_table := 'general_inventory_recount_items';
    v_item_id_column := 'recount_item_id';
  else
    v_count_table := 'general_inventory_validation_counts';
    v_item_table := 'general_inventory_validation_items';
    v_item_id_column := 'validation_item_id';
  end if;

  if p_mode = 'count' then
    for r in execute format(
      'select id, quantity from public.%I where session_id = $1 and product_id = $2 order by coalesce(updated_at, counted_at) desc nulls last, counted_at desc, id desc',
      v_count_table
    ) using p_session_id, p_product_id loop
      v_row_count := v_row_count + 1;
      v_old_total := v_old_total + coalesce(r.quantity, 0);
      if v_latest_id is null then
        v_latest_id := r.id;
        v_latest_qty := coalesce(r.quantity, 0);
      end if;
    end loop;
  else
    -- El resumen usa el item contado mas reciente por codigo; se modifica esa
    -- misma capa y no un item historico anterior.
    execute format(
      'select x.item_id from (
         select i.id as item_id,
                max(coalesce(c.updated_at, c.counted_at, i.updated_at, i.created_at)) as latest_at
           from public.%I i
           join public.%I c on c.%I = i.id and c.session_id = $1
          where i.session_id = $1 and i.product_id = $2 and i.status = ''counted''
          group by i.id
       ) x order by x.latest_at desc nulls last, x.item_id desc limit 1',
      v_item_table, v_count_table, v_item_id_column
    ) into v_item_id using p_session_id, p_product_id;
    if v_item_id is null then
      raise exception 'No existe un registro contado en la capa seleccionada';
    end if;

    for r in execute format(
      'select id, quantity from public.%I where session_id = $1 and %I = $2 order by coalesce(updated_at, counted_at) desc nulls last, counted_at desc, id desc',
      v_count_table, v_item_id_column
    ) using p_session_id, v_item_id loop
      v_row_count := v_row_count + 1;
      v_old_total := v_old_total + coalesce(r.quantity, 0);
      if v_latest_id is null then
        v_latest_id := r.id;
        v_latest_qty := coalesce(r.quantity, 0);
      end if;
    end loop;
  end if;

  if v_row_count = 0 then
    if p_mode <> 'count' then
      raise exception 'No existe un registro contado en la capa seleccionada';
    end if;
    if p_new_quantity <= 0 then
      raise exception 'Para crear un conteo nuevo la cantidad debe ser mayor que cero';
    end if;
    if nullif(trim(coalesce(p_location_code, '')), '') is null then
      raise exception 'Indica la ubicacion donde se realizo el conteo';
    end if;

    select * into v_location
    from public.general_inventory_locations
    where session_id = p_session_id
      and is_active = true
      and upper(trim(location_code)) = upper(trim(p_location_code))
    limit 1;
    if not found then
      raise exception 'La ubicacion % no existe en esta sesion', trim(p_location_code);
    end if;

    select so.operator_id into v_operator_id
    from public.general_inventory_session_operators so
    where so.session_id = p_session_id and so.status = 'active'
    order by so.joined_at asc
    limit 1;
    if v_operator_id is null then
      raise exception 'No existe un operador activo para registrar el conteo';
    end if;

    select p.* into v_product from public.cyclic_products p where p.id = p_product_id;
    if not found then raise exception 'Producto no encontrado'; end if;
    select s.* into v_snapshot
    from public.general_inventory_stock_snapshot s
    where s.session_id = p_session_id and s.product_id = p_product_id
    limit 1;
    v_cost := coalesce(v_snapshot.cost, v_product.cost, 0);

    insert into public.general_inventory_counts (
      session_id, operator_id, location_id, location_code, product_id, sku,
      description, unit, quantity, cost_snapshot, counted_at, updated_at
    ) values (
      p_session_id, v_operator_id, v_location.id, v_location.location_code,
      p_product_id, v_product.sku, v_product.description, v_product.unit,
      p_new_quantity, v_cost, v_now, v_now
    );
    v_old_total := 0;
    v_row_count := 1;
  else
    if p_new_quantity >= v_old_total then
      execute format('update public.%I set quantity = $1, updated_at = $2 where id = $3', v_count_table)
        using v_latest_qty + (p_new_quantity - v_old_total), v_now, v_latest_id;
    else
      v_remaining := v_old_total - p_new_quantity;
      for r in execute format(
        'select id, quantity from public.%I where session_id = $1 %s order by coalesce(updated_at, counted_at) desc nulls last, counted_at desc, id desc',
        v_count_table,
        case when p_mode = 'count' then 'and product_id = $2' else format('and %I = $2', v_item_id_column) end
      ) using p_session_id, case when p_mode = 'count' then p_product_id else v_item_id end loop
        exit when v_remaining <= 0;
        v_take := least(coalesce(r.quantity, 0), v_remaining);
        v_next := coalesce(r.quantity, 0) - v_take;
        -- general_inventory_counts exige quantity > 0; quitar una fila que
        -- quedo en cero conserva la ubicacion y evita una violacion de check.
        if p_mode = 'count' and v_next <= 0 then
          execute format('delete from public.%I where id = $1', v_count_table) using r.id;
        else
          execute format('update public.%I set quantity = $1, updated_at = $2 where id = $3', v_count_table)
            using v_next, v_now, r.id;
        end if;
        v_remaining := v_remaining - v_take;
      end loop;
      if v_remaining > 0.000001 then
        raise exception 'No se pudo distribuir la nueva cantidad';
      end if;
    end if;

    if p_mode <> 'count' then
      execute format('update public.%I set note = $1 where id = $2', v_count_table)
        using trim(p_note), v_latest_id;
      execute format(
        'update public.%I set counted_qty = $1, diff_qty = $1 - system_stock, value_diff = round((($1 - system_stock) * cost_snapshot)::numeric, 2), updated_at = $2 where id = $3 and session_id = $4',
        v_item_table
      ) using p_new_quantity, v_now, v_item_id, p_session_id;
    end if;
  end if;

  insert into public.general_inventory_quantity_edits (
    session_id, product_id, mode, old_quantity, new_quantity, note, editor_id, created_at
  ) values (
    p_session_id, p_product_id, p_mode, v_old_total, p_new_quantity, trim(p_note), p_editor_id, v_now
  );

  update public.general_inventory_sessions
  set status = 'finished',
      finished_at = v_session.finished_at,
      finished_by = v_session.finished_by,
      finished_by_name = v_session.finished_by_name,
      updated_at = v_now
  where id = p_session_id;

  return jsonb_build_object(
    'session_id', p_session_id,
    'product_id', p_product_id,
    'mode', p_mode,
    'old_quantity', v_old_total,
    'new_quantity', p_new_quantity,
    'created_new_count', (v_row_count = 1 and v_latest_id is null),
    'updated_at', v_now
  );
end;
$$;

revoke all on function public.edit_finished_general_inventory_quantity(uuid, uuid, text, uuid, numeric, text, text) from public;
grant execute on function public.edit_finished_general_inventory_quantity(uuid, uuid, text, uuid, numeric, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
