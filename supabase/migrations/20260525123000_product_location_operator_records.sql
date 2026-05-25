-- Registros persistentes por operario antes de confirmar ubicaciones al maestro.
-- Evita perder el avance si se apaga el celular o se cierra la PWA.
create table if not exists public.product_location_operator_records (
    id uuid primary key default gen_random_uuid(),
    store_id uuid not null references public.stores(id),
    product_id uuid not null references public.cyclic_products(id),
    sku text not null,
    location text not null,
    stored_quantity numeric,
    user_id uuid references public.cyclic_users(id),
    status text not null default 'draft' check (status in ('draft', 'saved')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    saved_at timestamptz
);

create unique index if not exists product_location_operator_records_unique_draft
    on public.product_location_operator_records (store_id, user_id, product_id, location)
    where status = 'draft';

create index if not exists product_location_operator_records_user_status_idx
    on public.product_location_operator_records (user_id, store_id, status, updated_at desc);
