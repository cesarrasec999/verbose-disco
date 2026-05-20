create table if not exists public.product_rotation_monthly (
  period_month date not null,
  store_key text not null,
  store_name text not null,
  product_code text not null,
  description text,
  unit text,
  rotation_category text not null,
  source_name text,
  uploaded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (period_month, store_key, product_code)
);

create index if not exists idx_product_rotation_monthly_product
  on public.product_rotation_monthly (product_code);

create index if not exists idx_product_rotation_monthly_store_month
  on public.product_rotation_monthly (store_key, period_month);

create index if not exists idx_product_rotation_monthly_category
  on public.product_rotation_monthly (rotation_category);

alter table public.product_rotation_monthly enable row level security;

drop policy if exists "product_rotation_monthly_select" on public.product_rotation_monthly;
create policy "product_rotation_monthly_select"
  on public.product_rotation_monthly
  for select
  using (true);

drop policy if exists "product_rotation_monthly_write" on public.product_rotation_monthly;
create policy "product_rotation_monthly_write"
  on public.product_rotation_monthly
  for all
  using (true)
  with check (true);

grant select, insert, update, delete on public.product_rotation_monthly to anon, authenticated, service_role;

notify pgrst, 'reload schema';
