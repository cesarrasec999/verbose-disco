-- Abastecimiento / recepcion de transferencias
-- Ejecutar despues de tener public.erp_movements y public.stores.

alter table public.erp_movements
  add column if not exists transfer_store_code text;

alter table public.erp_movements
  add column if not exists reference_document_no text;

create index if not exists idx_erp_movements_supply_transfer
  on public.erp_movements (operation, status, store_code, transfer_store_code, document_no, product_code);

create index if not exists idx_erp_movements_supply_incoming_transit
  on public.erp_movements (store_code, document_no, product_code, transfer_store_code, movement_date)
  where operation = 'Ingreso por Transferencia'
    and status in ('EN TRANSITO', 'TRANSITO', 'IN TRANSIT');

create index if not exists idx_erp_movements_supply_outgoing_transit
  on public.erp_movements (document_no, product_code, store_code, transfer_store_code, movement_date)
  where operation = 'Salida por Transferencia'
    and status in ('EN TRANSITO', 'TRANSITO', 'IN TRANSIT');

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

drop view if exists public.abastecimiento_delivery_pending;
drop view if exists public.abastecimiento_reception_pending;

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
where (
    upper(coalesce(arl.status_code, '')) in ('A', 'ACTIVO', 'APROBADO', 'APPROVED')
    or upper(coalesce(arl.status_name, '')) in ('ACTIVO', 'APROBADO', 'APPROVED')
  )
  and upper(coalesce(arl.status_code, '')) not in ('ANULADO', 'CERRADO', 'CANCELLED', 'CLOSED')
  and upper(coalesce(arl.status_name, '')) not in ('ANULADO', 'CERRADO', 'CANCELLED', 'CLOSED')
  and coalesce(arl.qty_pending, arl.qty_requested, 0) > 0;

create or replace view public.abastecimiento_reception_pending as
select
  arl.id as line_key,
  arl.inv_request_id,
  arl.inv_request_no,
  coalesce(nullif(arl.doc_number, ''), arl.inv_request_no, arl.inv_request_id) as document_no,
  arl.status_code,
  coalesce(arl.status_name, arl.status_code, 'Cerrado') as status_name,
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
  coalesce(nullif(arl.qty_pending, 0), arl.qty_requested, 0) as expected_qty,
  arl.request_date as request_created_at,
  arl.updated_at as delivered_at,
  arl.updated_at
from public.abastecimiento_request_lines arl
where (
    upper(coalesce(arl.status_code, '')) in ('C', 'X', 'CERRADO', 'CLOSED')
    or upper(coalesce(arl.status_name, '')) in ('CERRADO', 'CLOSED')
  )
  and coalesce(nullif(arl.qty_pending, 0), arl.qty_requested, 0) > 0;

notify pgrst, 'reload schema';
