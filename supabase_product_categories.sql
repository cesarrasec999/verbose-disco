-- Categorias de producto para reportes de inventario general.
-- Ejecutar en Supabase SQL Editor antes de correr la sincronizacion ERP.

alter table public.cyclic_products
  add column if not exists brand text,
  add column if not exists department text,
  add column if not exists class_name text,
  add column if not exists subclass_name text;

create index if not exists idx_cyclic_products_brand
  on public.cyclic_products(brand);

create index if not exists idx_cyclic_products_department
  on public.cyclic_products(department);

create index if not exists idx_cyclic_products_class_name
  on public.cyclic_products(class_name);

create index if not exists idx_cyclic_products_subclass_name
  on public.cyclic_products(subclass_name);

notify pgrst, 'reload schema';
