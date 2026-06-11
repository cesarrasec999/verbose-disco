create table if not exists public.historical_rotation_sales_import (
  id bigserial primary key,
  store_code text not null,
  store_name text null,
  movement_date date not null,
  operation text not null check (operation in ('Venta', 'Retorno')),
  document_no text not null,
  reference_document_no text null,
  product_code text not null,
  description text null,
  quantity numeric(18, 6) not null default 1,
  imported_at timestamptz not null default now()
);

create index if not exists idx_historical_rotation_sales_import_scope
  on public.historical_rotation_sales_import (store_code, product_code, movement_date);

create index if not exists idx_historical_rotation_sales_import_reference
  on public.historical_rotation_sales_import (store_code, product_code, reference_document_no);

-- Despues de importar el CSV a historical_rotation_sales_import, ejecuta este insert.
-- Usa prefijo HIST- para que no choque con movimientos actuales del ERP.
insert into public.erp_movements (
  movement_key,
  source_type,
  source_id,
  store_code,
  movement_date,
  operation,
  document_no,
  reference_document_no,
  product_code,
  description,
  quantity,
  reason,
  status,
  created_at,
  updated_at
)
select
  'HIST-' || upper(trim(store_code)) || '-' || upper(trim(product_code)) || '-' ||
    upper(trim(operation)) || '-' || upper(trim(document_no)) || '-' || id::text as movement_key,
  'historical_sales' as source_type,
  id::text as source_id,
  upper(trim(store_code)) as store_code,
  movement_date::timestamptz as movement_date,
  operation,
  upper(trim(document_no)) as document_no,
  nullif(upper(trim(reference_document_no)), '') as reference_document_no,
  upper(trim(product_code)) as product_code,
  nullif(trim(description), '') as description,
  case
    when operation = 'Retorno' then abs(quantity) * -1
    else abs(quantity)
  end as quantity,
  case
    when operation = 'Retorno' then 'HISTORICO NOTA CREDITO'
    else 'HISTORICO VENTA'
  end as reason,
  'ACTIVO' as status,
  now(),
  now()
from public.historical_rotation_sales_import
where nullif(trim(store_code), '') is not null
  and nullif(trim(product_code), '') is not null
  and nullif(trim(document_no), '') is not null
on conflict (movement_key, movement_date) do update set
  movement_date = excluded.movement_date,
  operation = excluded.operation,
  document_no = excluded.document_no,
  reference_document_no = excluded.reference_document_no,
  product_code = excluded.product_code,
  description = excluded.description,
  quantity = excluded.quantity,
  reason = excluded.reason,
  status = excluded.status,
  updated_at = now();

-- Recalculo posterior a la importacion.
select public.refresh_product_sales_daily(null::date, current_date, null::text, null::text);
select * from public.refresh_product_rotations(current_date, null::text, null::text);
