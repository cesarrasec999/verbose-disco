-- Llave interna ERP para evitar colisiones por codigos visibles de 5 digitos.
-- Ejecutar en Supabase SQL Editor y luego reiniciar/sincronizar erp-sync.

alter table public.stock_general
  add column if not exists erp_sku text null;

alter table public.codigos_barra
  add column if not exists erp_sku text null;

alter table public.cyclic_products
  add column if not exists erp_sku text null;

-- Backfill compatible con datos actuales. El sync ERP reemplazara erp_sku con p.SKU real.
update public.stock_general
set erp_sku = codsap
where erp_sku is null or btrim(erp_sku) = '';

update public.codigos_barra
set erp_sku = codsap
where erp_sku is null or btrim(erp_sku) = '';

-- Quitar unicidad antigua por sede+codsap para permitir varios SKU internos con el mismo codigo visible.
do $$
declare
  r record;
begin
  for r in
    select conname
    from pg_constraint
    where conrelid = 'public.stock_general'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) ilike '%(sede, codsap)%'
  loop
    execute format('alter table public.stock_general drop constraint if exists %I', r.conname);
  end loop;
end $$;

drop index if exists public.stock_general_sede_codsap_key;
drop index if exists public.idx_stock_general_sede_codsap_unique;

create unique index if not exists idx_stock_general_sede_erp_sku_unique
  on public.stock_general (sede, erp_sku);

create index if not exists idx_stock_general_sede_codsap
  on public.stock_general (sede, codsap);

create index if not exists idx_stock_general_codsap
  on public.stock_general (codsap);

create index if not exists idx_stock_general_erp_sku
  on public.stock_general (erp_sku);

create index if not exists idx_codigos_barra_erp_sku
  on public.codigos_barra (erp_sku);

create unique index if not exists idx_codigos_barra_erp_sku_upc_unique
  on public.codigos_barra (erp_sku, upc);

create unique index if not exists idx_cyclic_products_erp_sku_unique
  on public.cyclic_products (erp_sku);

notify pgrst, 'reload schema';
