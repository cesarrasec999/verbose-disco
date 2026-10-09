-- La ventana incremental relee el dia operativo para detectar correcciones de
-- RMS. No debe reescribir miles de filas identicas cada cinco minutos: eso
-- genera WAL, invalida cache y compite con los modulos en horario operativo.

create or replace function public.sync_erp_movements_batch(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_received integer;
  v_removed integer := 0;
  v_upserted integer := 0;
  v_provisional_changed integer := 0;
begin
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'p_rows debe ser un arreglo JSON';
  end if;

  v_received := jsonb_array_length(p_rows);
  if v_received = 0 then
    return jsonb_build_object(
      'received', 0,
      'removed_versions', 0,
      'upserted', 0,
      'provisional_changed', 0
    );
  end if;
  if v_received > 750 then
    raise exception 'El lote excede el maximo de 750 movimientos';
  end if;

  create temporary table tmp_erp_movements_batch (
    movement_key text not null,
    source_type text not null,
    source_id text,
    store_code text not null,
    movement_date timestamptz not null,
    operation text not null,
    document_no text,
    product_code text not null,
    description text,
    unit text,
    cost numeric,
    quantity numeric not null,
    value_total numeric,
    reason text,
    status text,
    transfer_store_code text,
    reference_document_no text,
    adjustment_user text,
    balance_after numeric,
    movement_employee text,
    reception_employee text,
    updated_at timestamptz not null
  ) on commit drop;

  insert into tmp_erp_movements_batch
  select
    x.movement_key, x.source_type, x.source_id, x.store_code,
    x.movement_date, x.operation, x.document_no, x.product_code,
    x.description, x.unit, x.cost, x.quantity, x.value_total, x.reason,
    x.status, x.transfer_store_code, x.reference_document_no,
    x.adjustment_user, x.balance_after, x.movement_employee,
    x.reception_employee, coalesce(x.updated_at, now())
  from jsonb_to_recordset(p_rows) as x(
    movement_key text,
    source_type text,
    source_id text,
    store_code text,
    movement_date timestamptz,
    operation text,
    document_no text,
    product_code text,
    description text,
    unit text,
    cost numeric,
    quantity numeric,
    value_total numeric,
    reason text,
    status text,
    transfer_store_code text,
    reference_document_no text,
    adjustment_user text,
    balance_after numeric,
    movement_employee text,
    reception_employee text,
    updated_at timestamptz
  );

  if (select count(*) from tmp_erp_movements_batch) <> v_received then
    raise exception 'El lote contiene movimientos invalidos o incompletos';
  end if;

  delete from public.erp_movements current_row
  using tmp_erp_movements_batch incoming
  where current_row.movement_key = incoming.movement_key
    and current_row.movement_date is distinct from incoming.movement_date;
  get diagnostics v_removed = row_count;

  with changed as (
    insert into public.erp_movements as current_row (
      movement_key, source_type, source_id, store_code, movement_date,
      operation, document_no, product_code, description, unit, cost,
      quantity, value_total, reason, status, transfer_store_code,
      reference_document_no, adjustment_user, balance_after,
      movement_employee, reception_employee, updated_at
    )
    select
      movement_key, source_type, source_id, store_code, movement_date,
      operation, document_no, product_code, description, unit, cost,
      quantity, value_total, reason, status, transfer_store_code,
      reference_document_no, adjustment_user, balance_after,
      movement_employee, reception_employee, updated_at
    from tmp_erp_movements_batch
    on conflict (movement_key, movement_date) do update set
      source_type = excluded.source_type,
      source_id = excluded.source_id,
      store_code = excluded.store_code,
      operation = excluded.operation,
      document_no = excluded.document_no,
      product_code = excluded.product_code,
      description = excluded.description,
      unit = excluded.unit,
      cost = excluded.cost,
      quantity = excluded.quantity,
      value_total = excluded.value_total,
      reason = excluded.reason,
      status = excluded.status,
      transfer_store_code = excluded.transfer_store_code,
      reference_document_no = excluded.reference_document_no,
      adjustment_user = excluded.adjustment_user,
      balance_after = excluded.balance_after,
      movement_employee = excluded.movement_employee,
      reception_employee = excluded.reception_employee,
      updated_at = excluded.updated_at
    where row(
      current_row.source_type,
      current_row.source_id,
      current_row.store_code,
      current_row.operation,
      current_row.document_no,
      current_row.product_code,
      current_row.description,
      current_row.unit,
      current_row.cost,
      current_row.quantity,
      current_row.value_total,
      current_row.reason,
      current_row.status,
      current_row.transfer_store_code,
      current_row.reference_document_no,
      current_row.adjustment_user,
      current_row.balance_after,
      current_row.movement_employee,
      current_row.reception_employee
    ) is distinct from row(
      excluded.source_type,
      excluded.source_id,
      excluded.store_code,
      excluded.operation,
      excluded.document_no,
      excluded.product_code,
      excluded.description,
      excluded.unit,
      excluded.cost,
      excluded.quantity,
      excluded.value_total,
      excluded.reason,
      excluded.status,
      excluded.transfer_store_code,
      excluded.reference_document_no,
      excluded.adjustment_user,
      excluded.balance_after,
      excluded.movement_employee,
      excluded.reception_employee
    )
    returning reason
  )
  select
    count(*)::integer,
    count(*) filter (
      where reason in ('06. INGRESOS PROVISIONALES', '07. REGULARIZACION DE PROVISIONAL')
    )::integer
  into v_upserted, v_provisional_changed
  from changed;

  return jsonb_build_object(
    'received', v_received,
    'removed_versions', v_removed,
    'upserted', v_upserted,
    'provisional_changed', v_provisional_changed
  );
end;
$$;

revoke all on function public.sync_erp_movements_batch(jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_erp_movements_batch(jsonb)
  to service_role;

notify pgrst, 'reload schema';
