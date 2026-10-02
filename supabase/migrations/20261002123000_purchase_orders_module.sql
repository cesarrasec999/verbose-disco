-- Módulo de Órdenes de Compra RMS.
-- Solo replica información del ERP; no modifica las OC originales ni los ingresos.

create extension if not exists pg_trgm with schema extensions;

create table if not exists public.erp_purchase_orders (
  erp_po_id text primary key,
  po_number text not null,
  po_number_suffix text generated always as (right(regexp_replace(po_number, '[^0-9]', '', 'g'), 5)) stored,
  po_no bigint,
  raw_status_code text not null,
  business_status text not null check (business_status in ('pending', 'closed', 'cancelled')),
  po_type_code text,
  source_code text,
  store_no text not null,
  store_code text,
  store_name text,
  vendor_code text,
  vendor_name text,
  buyer text,
  po_date timestamptz not null,
  ship_date timestamptz,
  cancel_date timestamptz,
  closed_at timestamptz,
  source_created_at timestamptz,
  source_changed_at timestamptz,
  line_count integer not null default 0,
  qty_ordered numeric(18, 6) not null default 0,
  qty_received numeric(18, 6) not null default 0,
  qty_due numeric(18, 6) not null default 0,
  cost_total numeric(18, 6) not null default 0,
  retail_total numeric(18, 6) not null default 0,
  total numeric(18, 6) not null default 0,
  currency_id integer,
  notes text,
  source_sync_run_id uuid,
  synced_at timestamptz not null default now()
);

create table if not exists public.erp_purchase_order_lines (
  erp_po_id text not null references public.erp_purchase_orders(erp_po_id) on delete cascade,
  line_id integer not null,
  sku text,
  product_code text not null,
  product_code_suffix text generated always as (right(regexp_replace(product_code, '[^0-9]', '', 'g'), 5)) stored,
  barcode text,
  description text,
  unit text,
  raw_status_code text,
  qty_ordered numeric(18, 6) not null default 0,
  qty_received numeric(18, 6) not null default 0,
  qty_due numeric(18, 6) not null default 0,
  cost numeric(18, 6) not null default 0,
  ext_cost numeric(18, 6) not null default 0,
  price numeric(18, 6) not null default 0,
  ext_price numeric(18, 6) not null default 0,
  estimated_date timestamptz,
  notes text,
  source_sync_run_id uuid,
  synced_at timestamptz not null default now(),
  primary key (erp_po_id, line_id)
);

-- Listado: primero acota por estado/tienda/fecha y recién pagina.
create index if not exists idx_erp_purchase_orders_status_date
  on public.erp_purchase_orders (business_status, po_date desc, erp_po_id);
create index if not exists idx_erp_purchase_orders_store_date
  on public.erp_purchase_orders (store_no, po_date desc, erp_po_id);
create index if not exists idx_erp_purchase_orders_date
  on public.erp_purchase_orders (po_date desc, erp_po_id);
create index if not exists idx_erp_purchase_orders_number_suffix
  on public.erp_purchase_orders (po_number_suffix);
create index if not exists idx_erp_purchase_orders_number_trgm
  on public.erp_purchase_orders using gin (upper(po_number) extensions.gin_trgm_ops);
create index if not exists idx_erp_purchase_orders_vendor_trgm
  on public.erp_purchase_orders using gin (upper(coalesce(vendor_name, '')) extensions.gin_trgm_ops);

-- Detalle y búsqueda por código/últimos cinco dígitos.
create index if not exists idx_erp_purchase_order_lines_po
  on public.erp_purchase_order_lines (erp_po_id, line_id);
create index if not exists idx_erp_purchase_order_lines_code_suffix
  on public.erp_purchase_order_lines (product_code_suffix, erp_po_id);
create index if not exists idx_erp_purchase_order_lines_code_trgm
  on public.erp_purchase_order_lines using gin (upper(product_code) extensions.gin_trgm_ops);

alter table public.erp_purchase_orders enable row level security;
alter table public.erp_purchase_order_lines enable row level security;

drop policy if exists "purchase_orders_read" on public.erp_purchase_orders;
create policy "purchase_orders_read" on public.erp_purchase_orders
  for select to anon, authenticated using (true);
drop policy if exists "purchase_order_lines_read" on public.erp_purchase_order_lines;
create policy "purchase_order_lines_read" on public.erp_purchase_order_lines
  for select to anon, authenticated using (true);

grant select on public.erp_purchase_orders, public.erp_purchase_order_lines to anon, authenticated;
grant select, insert, update, delete on public.erp_purchase_orders, public.erp_purchase_order_lines to service_role;

create or replace function public.get_purchase_orders_page(
  p_status text default 'all',
  p_date_from date default null,
  p_date_to date default null,
  p_store_no text default null,
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  erp_po_id text,
  po_number text,
  raw_status_code text,
  business_status text,
  store_no text,
  store_code text,
  store_name text,
  vendor_code text,
  vendor_name text,
  buyer text,
  po_date timestamptz,
  ship_date timestamptz,
  closed_at timestamptz,
  line_count integer,
  qty_ordered numeric,
  qty_received numeric,
  qty_due numeric,
  total numeric,
  synced_at timestamptz,
  total_count bigint
)
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_search text := upper(btrim(coalesce(p_search, '')));
  v_digits text := regexp_replace(coalesce(p_search, ''), '[^0-9]', '', 'g');
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  set local statement_timeout = '20s';

  return query
  select po.erp_po_id, po.po_number, po.raw_status_code, po.business_status,
         po.store_no, po.store_code, po.store_name, po.vendor_code, po.vendor_name,
         po.buyer, po.po_date, po.ship_date, po.closed_at, po.line_count,
         po.qty_ordered, po.qty_received, po.qty_due, po.total, po.synced_at,
         count(*) over() as total_count
  from public.erp_purchase_orders po
  where (coalesce(p_status, 'all') = 'all' or po.business_status = p_status)
    and (p_date_from is null or po.po_date >= (p_date_from::timestamp at time zone 'America/Lima'))
    and (p_date_to is null or po.po_date < ((p_date_to + 1)::timestamp at time zone 'America/Lima'))
    and (nullif(btrim(coalesce(p_store_no, '')), '') is null or po.store_no = btrim(p_store_no))
    and (
      v_search = ''
      or upper(po.po_number) like '%' || v_search || '%'
      or upper(coalesce(po.vendor_code, '')) like '%' || v_search || '%'
      or upper(coalesce(po.vendor_name, '')) like '%' || v_search || '%'
      or (length(v_digits) >= 5 and po.po_number_suffix = right(v_digits, 5))
      or exists (
        select 1
        from public.erp_purchase_order_lines line
        where line.erp_po_id = po.erp_po_id
          and (
            upper(line.product_code) like '%' || v_search || '%'
            or upper(coalesce(line.sku, '')) like '%' || v_search || '%'
            or upper(coalesce(line.barcode, '')) like '%' || v_search || '%'
            or (length(v_digits) >= 5 and line.product_code_suffix = right(v_digits, 5))
          )
      )
    )
  order by po.po_date desc, po.erp_po_id
  limit v_limit offset v_offset;
end;
$$;

create or replace function public.get_purchase_orders_summary(
  p_date_from date default null,
  p_date_to date default null,
  p_store_no text default null,
  p_search text default null
)
returns table (
  total_orders bigint,
  pending_orders bigint,
  closed_orders bigint,
  cancelled_orders bigint,
  total_amount numeric
)
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_search text := upper(btrim(coalesce(p_search, '')));
  v_digits text := regexp_replace(coalesce(p_search, ''), '[^0-9]', '', 'g');
begin
  set local statement_timeout = '20s';

  return query
  select count(*)::bigint,
         count(*) filter (where po.business_status = 'pending')::bigint,
         count(*) filter (where po.business_status = 'closed')::bigint,
         count(*) filter (where po.business_status = 'cancelled')::bigint,
         coalesce(sum(po.total), 0)::numeric
  from public.erp_purchase_orders po
  where (p_date_from is null or po.po_date >= (p_date_from::timestamp at time zone 'America/Lima'))
    and (p_date_to is null or po.po_date < ((p_date_to + 1)::timestamp at time zone 'America/Lima'))
    and (nullif(btrim(coalesce(p_store_no, '')), '') is null or po.store_no = btrim(p_store_no))
    and (
      v_search = ''
      or upper(po.po_number) like '%' || v_search || '%'
      or upper(coalesce(po.vendor_code, '')) like '%' || v_search || '%'
      or upper(coalesce(po.vendor_name, '')) like '%' || v_search || '%'
      or (length(v_digits) >= 5 and po.po_number_suffix = right(v_digits, 5))
      or exists (
        select 1 from public.erp_purchase_order_lines line
        where line.erp_po_id = po.erp_po_id
          and (
            upper(line.product_code) like '%' || v_search || '%'
            or upper(coalesce(line.sku, '')) like '%' || v_search || '%'
            or upper(coalesce(line.barcode, '')) like '%' || v_search || '%'
            or (length(v_digits) >= 5 and line.product_code_suffix = right(v_digits, 5))
          )
      )
    );
end;
$$;

create or replace function public.get_purchase_order_lines_page(
  p_erp_po_id text,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  line_id integer,
  sku text,
  product_code text,
  barcode text,
  description text,
  unit text,
  raw_status_code text,
  qty_ordered numeric,
  qty_received numeric,
  qty_due numeric,
  cost numeric,
  ext_cost numeric,
  price numeric,
  ext_price numeric,
  estimated_date timestamptz,
  notes text,
  total_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select line.line_id, line.sku, line.product_code, line.barcode,
         line.description, line.unit, line.raw_status_code, line.qty_ordered,
         line.qty_received, line.qty_due, line.cost, line.ext_cost,
         line.price, line.ext_price, line.estimated_date, line.notes,
         count(*) over() as total_count
  from public.erp_purchase_order_lines line
  where line.erp_po_id = p_erp_po_id
  order by line.line_id
  limit least(greatest(coalesce(p_limit, 50), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0)
$$;

grant execute on function public.get_purchase_orders_page(text, date, date, text, text, integer, integer)
  to anon, authenticated, service_role;
grant execute on function public.get_purchase_orders_summary(date, date, text, text)
  to anon, authenticated, service_role;
grant execute on function public.get_purchase_order_lines_page(text, integer, integer)
  to anon, authenticated, service_role;

-- Los perfiles administrativos existentes reciben el nuevo permiso sin
-- reemplazar ni eliminar sus permisos actuales.
update public.cyclic_users
set module_access = module_access || '["purchase_orders"]'::jsonb
where role in ('Administrador', 'Supervisor', 'Validador')
  and module_access is not null
  and jsonb_array_length(module_access) > 0
  and not (module_access ? 'purchase_orders');

notify pgrst, 'reload schema';
