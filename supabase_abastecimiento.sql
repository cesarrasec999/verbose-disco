-- Abastecimiento / recepcion de transferencias
-- Ejecutar despues de tener public.erp_movements y public.stores.

alter table public.erp_movements
  add column if not exists transfer_store_code text;

create index if not exists idx_erp_movements_supply_transfer
  on public.erp_movements (operation, status, store_code, transfer_store_code, document_no, product_code);

create table if not exists public.abastecimiento_request_lines (
  id text primary key,
  inv_request_id text not null,
  inv_request_no text,
  doc_number text,
  status_code text,
  status_name text,
  request_date timestamptz,
  creation_date timestamptz,
  destination_store_code text not null,
  destination_store_name text,
  source_store_code text not null,
  source_store_name text,
  reason text,
  notes text,
  line_id integer not null,
  sku text,
  product_code text not null,
  barcode text,
  description text,
  unit text,
  qty_requested numeric(18, 6) not null default 0,
  qty_pending numeric(18, 6) not null default 0,
  source_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (inv_request_id, line_id)
);

create index if not exists idx_abast_req_source_status
  on public.abastecimiento_request_lines (source_store_code, status_code);

create index if not exists idx_abast_req_dest_status
  on public.abastecimiento_request_lines (destination_store_code, status_code);

create index if not exists idx_abast_req_product
  on public.abastecimiento_request_lines (product_code);

create table if not exists public.abastecimiento_receipt_counts (
  id uuid primary key default gen_random_uuid(),
  line_key text not null,
  document_no text not null,
  destination_store_code text not null,
  source_store_code text,
  product_code text not null,
  description text,
  expected_qty numeric(18, 6) not null default 0,
  counted_qty numeric(18, 6) not null default 0,
  counted_by uuid references public.cyclic_users(id),
  counted_by_name text,
  counted_at timestamptz not null default now()
);

create index if not exists idx_abast_counts_line
  on public.abastecimiento_receipt_counts (line_key);

create index if not exists idx_abast_counts_doc_store
  on public.abastecimiento_receipt_counts (destination_store_code, document_no);

create or replace view public.abastecimiento_delivery_pending as
select
  arl.id as line_key,
  arl.inv_request_id,
  arl.inv_request_no,
  coalesce(nullif(arl.doc_number, ''), arl.inv_request_no, arl.inv_request_id) as document_no,
  arl.status_code,
  coalesce(arl.status_name, arl.status_code) as status_name,
  arl.request_date,
  arl.creation_date,
  arl.destination_store_code,
  arl.destination_store_name,
  arl.source_store_code,
  arl.source_store_name,
  arl.reason,
  arl.notes,
  arl.line_id,
  coalesce(nullif(arl.product_code, ''), nullif(arl.sku, '')) as product_code,
  arl.barcode,
  arl.description,
  arl.unit,
  arl.qty_requested,
  arl.qty_pending,
  arl.updated_at
from public.abastecimiento_request_lines arl
where upper(coalesce(arl.status_code, '')) in ('A', 'ACTIVO', 'APPROVED')
  and coalesce(arl.qty_pending, arl.qty_requested, 0) > 0;

create or replace view public.abastecimiento_reception_pending as
with incoming as (
  select
    m.movement_key,
    nullif(trim(m.document_no), '') as document_no,
    trim(m.store_code) as destination_store_code,
    trim(coalesce(m.transfer_store_code, '')) as source_store_code,
    upper(trim(m.product_code)) as product_code,
    m.description,
    m.unit,
    m.cost,
    m.quantity,
    m.reason,
    m.status,
    m.movement_date,
    m.updated_at
  from public.erp_movements m
  where m.operation = 'Ingreso por Transferencia'
    and upper(coalesce(m.status, '')) in ('EN TRANSITO', 'TRANSITO', 'IN TRANSIT')
),
outgoing as (
  select
    nullif(trim(m.document_no), '') as document_no,
    trim(m.store_code) as source_store_code,
    trim(coalesce(m.transfer_store_code, '')) as destination_store_code,
    upper(trim(m.product_code)) as product_code,
    abs(sum(m.quantity)) as sent_qty,
    max(m.movement_date) as delivered_at
  from public.erp_movements m
  where m.operation = 'Salida por Transferencia'
    and upper(coalesce(m.status, '')) in ('EN TRANSITO', 'TRANSITO', 'IN TRANSIT')
  group by nullif(trim(m.document_no), ''), trim(m.store_code), trim(coalesce(m.transfer_store_code, '')), upper(trim(m.product_code))
)
select
  concat_ws('|', i.document_no, i.destination_store_code, coalesce(nullif(i.source_store_code, ''), o.source_store_code), i.product_code) as line_key,
  i.document_no,
  i.destination_store_code,
  coalesce(nullif(i.source_store_code, ''), o.source_store_code) as source_store_code,
  i.product_code,
  i.description,
  i.unit,
  i.cost,
  coalesce(nullif(abs(i.quantity), 0), o.sent_qty, 0) as expected_qty,
  i.reason,
  i.status,
  i.movement_date as request_created_at,
  o.delivered_at,
  i.updated_at
from incoming i
left join outgoing o
  on o.document_no is not distinct from i.document_no
 and o.product_code = i.product_code
 and (
   nullif(i.source_store_code, '') is null
   or o.source_store_code = i.source_store_code
 )
 and (
   nullif(i.destination_store_code, '') is null
   or o.destination_store_code = i.destination_store_code
 );

notify pgrst, 'reload schema';
