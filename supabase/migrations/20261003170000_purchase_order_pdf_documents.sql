-- Evidencia inmutable de las ordenes de compra aprobadas.
-- Las vistas previas pendientes se generan al vuelo; una OC aprobada se
-- conserva en almacenamiento privado junto con el hash de sus firmas.

create table if not exists public.purchase_order_pdf_documents (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null unique references public.purchase_order_approval_routes(id) on delete restrict,
  erp_po_id text not null references public.erp_purchase_orders(erp_po_id) on delete restrict,
  approval_version integer not null,
  storage_path text not null unique,
  sha256 text not null,
  file_size integer not null check (file_size > 0),
  signature_snapshot jsonb not null default '[]'::jsonb,
  generated_by uuid null references public.cyclic_users(id) on delete set null,
  generated_at timestamptz not null default now()
);

create index if not exists idx_purchase_order_pdf_documents_po
  on public.purchase_order_pdf_documents (erp_po_id, approval_version desc);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('purchase-order-documents', 'purchase-order-documents', false, 15728640, array['application/pdf'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.purchase_order_pdf_documents enable row level security;

grant all on public.purchase_order_pdf_documents to service_role;

