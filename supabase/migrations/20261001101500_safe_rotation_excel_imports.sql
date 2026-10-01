-- Importaciones manuales de rotación con staging, respaldo y aplicación atómica.
-- La fuente Excel reemplaza únicamente el periodo y las tiendas incluidas.

create table if not exists public.product_rotation_import_runs (
  id uuid primary key default gen_random_uuid(),
  period_month date not null,
  source_name text not null,
  source_sha256 text not null,
  status text not null default 'staging'
    check (status in ('staging', 'applying', 'applied', 'failed')),
  expected_rows integer not null check (expected_rows > 0),
  staged_rows integer not null default 0,
  applied_rows integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);

create table if not exists public.product_rotation_import_staging (
  run_id uuid not null references public.product_rotation_import_runs(id) on delete cascade,
  store_key text not null,
  store_name text not null,
  product_code text not null,
  description text not null default '',
  unit text not null default '',
  rotation_category text not null,
  primary key (run_id, store_key, product_code)
);

create table if not exists public.product_rotation_import_backup (
  run_id uuid not null references public.product_rotation_import_runs(id) on delete cascade,
  period_month date not null,
  store_key text not null,
  store_name text not null,
  product_code text not null,
  description text,
  unit text,
  rotation_category text not null,
  source_name text,
  uploaded_at timestamptz not null,
  updated_at timestamptz not null,
  store_profile text,
  first_sale_date date,
  last_sale_date date,
  sales_documents_total numeric not null,
  avg_sales_documents_month numeric not null,
  history_months numeric not null,
  primary key (run_id, period_month, store_key, product_code)
);

create table if not exists public.product_rotation_import_store_backup (
  run_id uuid not null references public.product_rotation_import_runs(id) on delete cascade,
  store_code text not null,
  product_code text not null,
  row_data jsonb not null,
  primary key (run_id, store_code, product_code)
);

create table if not exists public.product_rotation_import_summary_backup (
  run_id uuid not null references public.product_rotation_import_runs(id) on delete cascade,
  store_code text not null,
  row_data jsonb not null,
  primary key (run_id, store_code)
);

create index if not exists idx_rotation_import_staging_run_category
  on public.product_rotation_import_staging (run_id, rotation_category, store_key);

alter table public.product_rotation_import_runs enable row level security;
alter table public.product_rotation_import_staging enable row level security;
alter table public.product_rotation_import_backup enable row level security;
alter table public.product_rotation_import_store_backup enable row level security;
alter table public.product_rotation_import_summary_backup enable row level security;

revoke all on public.product_rotation_import_runs from anon, authenticated;
revoke all on public.product_rotation_import_staging from anon, authenticated;
revoke all on public.product_rotation_import_backup from anon, authenticated;
revoke all on public.product_rotation_import_store_backup from anon, authenticated;
revoke all on public.product_rotation_import_summary_backup from anon, authenticated;

grant all on public.product_rotation_import_runs to service_role;
grant all on public.product_rotation_import_staging to service_role;
grant all on public.product_rotation_import_backup to service_role;
grant all on public.product_rotation_import_store_backup to service_role;
grant all on public.product_rotation_import_summary_backup to service_role;

create or replace function public.apply_product_rotation_import(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.product_rotation_import_runs%rowtype;
  v_staged integer;
  v_stores integer;
  v_products integer;
  v_previous integer;
  v_current_updated integer;
  v_applied integer;
begin
  select * into v_run
  from public.product_rotation_import_runs
  where id = p_run_id
  for update;

  if not found then
    raise exception 'Importación de rotaciones no encontrada: %', p_run_id;
  end if;
  if v_run.status <> 'staging' then
    raise exception 'La importación % está en estado %, se esperaba staging', p_run_id, v_run.status;
  end if;

  select count(*), count(distinct store_key), count(distinct product_code)
  into v_staged, v_stores, v_products
  from public.product_rotation_import_staging
  where run_id = p_run_id;

  if v_staged <> v_run.expected_rows then
    raise exception 'Staging incompleto: % de % filas', v_staged, v_run.expected_rows;
  end if;
  if exists (
    select 1 from public.product_rotation_import_staging
    where run_id = p_run_id
      and upper(btrim(rotation_category)) not in ('A','B','C','D','E','X','P','SR','NUEVO')
  ) then
    raise exception 'La importación contiene categorías de rotación no permitidas';
  end if;
  if exists (
    select 1
    from public.product_rotation_import_staging st
    where st.run_id = p_run_id
      and not exists (
        select 1 from public.cyclic_products p
        where upper(btrim(p.sku)) = upper(btrim(st.product_code))
           or upper(btrim(coalesce(p.erp_sku, ''))) = upper(btrim(st.product_code))
      )
  ) then
    raise exception 'La importación contiene códigos que no existen en el maestro';
  end if;
  if exists (
    select 1
    from (select distinct store_name from public.product_rotation_import_staging where run_id = p_run_id) st
    where not exists (
      select 1 from public.stores s
      where s.is_active
        and (upper(btrim(s.name)) = upper(btrim(st.store_name))
          or upper(btrim(coalesce(s.erp_sede, ''))) = upper(btrim(st.store_name)))
    )
  ) then
    raise exception 'La importación contiene tiendas que no existen o están inactivas';
  end if;

  perform pg_advisory_xact_lock(hashtext('product_rotation_import:' || v_run.period_month::text));
  lock table public.product_rotation_monthly in share row exclusive mode;
  lock table public.product_rotation_store in share row exclusive mode;

  update public.product_rotation_import_runs
  set status = 'applying', staged_rows = v_staged
  where id = p_run_id;

  insert into public.product_rotation_import_backup (
    run_id, period_month, store_key, store_name, product_code, description, unit,
    rotation_category, source_name, uploaded_at, updated_at, store_profile,
    first_sale_date, last_sale_date, sales_documents_total,
    avg_sales_documents_month, history_months
  )
  select p_run_id, prm.period_month, prm.store_key, prm.store_name, prm.product_code,
    prm.description, prm.unit, prm.rotation_category, prm.source_name,
    prm.uploaded_at, prm.updated_at, prm.store_profile, prm.first_sale_date,
    prm.last_sale_date, prm.sales_documents_total,
    prm.avg_sales_documents_month, prm.history_months
  from public.product_rotation_monthly prm
  where prm.period_month = v_run.period_month
    and exists (
      select 1 from public.product_rotation_import_staging st
      where st.run_id = p_run_id and st.store_key = prm.store_key
    )
  on conflict do nothing;

  insert into public.product_rotation_import_store_backup (run_id, store_code, product_code, row_data)
  select p_run_id, prs.store_code, prs.product_code, to_jsonb(prs)
  from public.product_rotation_store prs
  where exists (
    select 1 from public.product_rotation_import_staging st
    where st.run_id = p_run_id
      and upper(btrim(st.product_code)) = upper(btrim(prs.product_code))
      and (upper(btrim(st.store_key)) = upper(btrim(prs.store_code))
        or upper(btrim(st.store_name)) = upper(btrim(coalesce(prs.store_name, ''))))
  )
  on conflict do nothing;

  insert into public.product_rotation_import_summary_backup (run_id, store_code, row_data)
  select p_run_id, prs.store_code, to_jsonb(prs)
  from public.product_rotation_summary prs
  where exists (
    select 1 from public.product_rotation_import_staging st
    where st.run_id = p_run_id
      and (upper(btrim(st.store_key)) = upper(btrim(prs.store_code))
        or upper(btrim(st.store_name)) = upper(btrim(coalesce(prs.store_name, ''))))
  )
  on conflict do nothing;

  delete from public.product_rotation_monthly prm
  where prm.period_month = v_run.period_month
    and exists (
      select 1 from public.product_rotation_import_staging st
      where st.run_id = p_run_id and st.store_key = prm.store_key
    );
  get diagnostics v_previous = row_count;

  insert into public.product_rotation_monthly (
    period_month, store_key, store_name, product_code, description, unit,
    rotation_category, source_name, uploaded_at, updated_at, store_profile,
    first_sale_date, last_sale_date, sales_documents_total,
    avg_sales_documents_month, history_months
  )
  select v_run.period_month, st.store_key, st.store_name, st.product_code,
    st.description, st.unit, upper(btrim(st.rotation_category)), v_run.source_name,
    now(), now(), 'retail', null, null, 0, 0, 0
  from public.product_rotation_import_staging st
  where st.run_id = p_run_id;
  get diagnostics v_applied = row_count;

  update public.product_rotation_store prs
  set rotation_category = upper(btrim(st.rotation_category)),
      calculated_at = now(),
      description = coalesce(nullif(prs.description, ''), st.description)
  from public.product_rotation_import_staging st
  where st.run_id = p_run_id
    and upper(btrim(st.product_code)) = upper(btrim(prs.product_code))
    and (upper(btrim(st.store_key)) = upper(btrim(prs.store_code))
      or upper(btrim(st.store_name)) = upper(btrim(coalesce(prs.store_name, ''))));
  get diagnostics v_current_updated = row_count;

  insert into public.product_rotation_summary (
    store_code, store_name, store_profile, total_codes, category_a, category_b,
    category_c, category_d, category_nuevo, category_x, category_h, calculated_at
  )
  select st.store_key, min(st.store_name), 'retail', count(*)::integer,
    count(*) filter (where upper(st.rotation_category) = 'A')::integer,
    count(*) filter (where upper(st.rotation_category) = 'B')::integer,
    count(*) filter (where upper(st.rotation_category) = 'C')::integer,
    count(*) filter (where upper(st.rotation_category) = 'D')::integer,
    count(*) filter (where upper(st.rotation_category) = 'NUEVO')::integer,
    count(*) filter (where upper(st.rotation_category) = 'X')::integer,
    count(*) filter (where upper(st.rotation_category) = 'H')::integer,
    now()
  from public.product_rotation_import_staging st
  where st.run_id = p_run_id
  group by st.store_key
  on conflict (store_code) do update set
    store_name = excluded.store_name,
    store_profile = excluded.store_profile,
    total_codes = excluded.total_codes,
    category_a = excluded.category_a,
    category_b = excluded.category_b,
    category_c = excluded.category_c,
    category_d = excluded.category_d,
    category_nuevo = excluded.category_nuevo,
    category_x = excluded.category_x,
    category_h = excluded.category_h,
    calculated_at = excluded.calculated_at;

  update public.product_rotation_import_runs
  set status = 'applied', staged_rows = v_staged, applied_rows = v_applied,
      applied_at = now(),
      metadata = metadata || jsonb_build_object(
        'stores', v_stores,
        'products', v_products,
        'previous_rows_backed_up', v_previous,
        'current_rows_updated', v_current_updated
      )
  where id = p_run_id;

  delete from public.product_rotation_import_staging where run_id = p_run_id;

  return jsonb_build_object(
    'run_id', p_run_id,
    'period_month', v_run.period_month,
    'stores', v_stores,
    'products', v_products,
    'applied_rows', v_applied,
    'previous_rows_backed_up', v_previous,
    'current_rows_updated', v_current_updated
  );
end;
$$;

revoke all on function public.apply_product_rotation_import(uuid) from public, anon, authenticated;
grant execute on function public.apply_product_rotation_import(uuid) to service_role;

notify pgrst, 'reload schema';
