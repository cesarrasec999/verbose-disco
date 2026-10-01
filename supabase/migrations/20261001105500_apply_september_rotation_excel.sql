-- Aplica la carga validada de septiembre por la conexión directa de migraciones.
-- En entornos que no contienen este staging, la migración es un no-op seguro.
set statement_timeout = '10min';

do $$
declare
  v_run_id uuid;
  v_result jsonb;
begin
  select id into v_run_id
  from public.product_rotation_import_runs
  where period_month = '2026-09-01'::date
    and source_sha256 = '3687e9aeb338daeef725e7bbc31fcf688b4be2f1c930726ae2430a711803fbd9'
    and status in ('staging', 'failed')
  order by created_at desc
  limit 1;

  if v_run_id is null then
    raise notice 'No existe staging pendiente para ROT DE TIENDAS SETIEMBRE 2026.xlsx';
    return;
  end if;

  update public.product_rotation_import_runs
  set status = 'staging', error_message = null
  where id = v_run_id;

  v_result := public.apply_product_rotation_import(v_run_id);
  raise notice 'Rotaciones de septiembre aplicadas: %', v_result;
end;
$$;
