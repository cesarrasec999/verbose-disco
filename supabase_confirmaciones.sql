-- Modulo Confirmaciones: solicitudes de cajero y validacion de pagos.
-- Ejecutar una vez en Supabase SQL Editor. Es idempotente.

create table if not exists public.payment_confirmations (
  id uuid primary key default gen_random_uuid(),
  store_id uuid references public.stores(id) on delete set null,
  store_name text not null,
  cashier_id uuid references public.cyclic_users(id) on delete set null,
  cashier_name text not null,
  document_reference text not null,
  amount numeric(12,2) not null check (amount > 0),
  payment_method text not null default 'Yape' check (payment_method in ('Yape', 'Plin', 'Deposito')),
  photo_path text not null,
  photo_taken_at timestamptz not null,
  registered_at timestamptz not null default now(),
  status text not null default 'Pendiente' check (status in ('Pendiente', 'Confirmado', 'Anulacion solicitada', 'Anulado')),
  opened_at timestamptz,
  opened_by uuid references public.cyclic_users(id) on delete set null,
  opened_by_name text,
  operation_number text,
  bank text,
  validator_id uuid references public.cyclic_users(id) on delete set null,
  validator_name text,
  confirmed_at timestamptz,
  cancellation_requested_at timestamptz,
  cancellation_reason text,
  cancellation_validator_id uuid references public.cyclic_users(id) on delete set null,
  cancellation_validator_name text,
  cancelled_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists payment_confirmations_operation_number_uidx
  on public.payment_confirmations (lower(operation_number))
  where operation_number is not null and btrim(operation_number) <> '';

create index if not exists payment_confirmations_status_idx
  on public.payment_confirmations (status, registered_at desc);

create index if not exists payment_confirmations_store_date_idx
  on public.payment_confirmations (store_id, registered_at desc);

create or replace function public.touch_payment_confirmations_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_payment_confirmations_updated_at on public.payment_confirmations;
create trigger trg_payment_confirmations_updated_at
before update on public.payment_confirmations
for each row execute function public.touch_payment_confirmations_updated_at();

insert into storage.buckets (id, name, public)
values ('payment-confirmations', 'payment-confirmations', true)
on conflict (id) do update set public = excluded.public;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'payment_confirmations_public_read'
  ) then
    create policy payment_confirmations_public_read
      on storage.objects for select
      using (bucket_id = 'payment-confirmations');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'payment_confirmations_public_insert'
  ) then
    create policy payment_confirmations_public_insert
      on storage.objects for insert
      with check (bucket_id = 'payment-confirmations');
  end if;
end $$;

do $$
declare
  constraint_name text;
begin
  select con.conname
    into constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'cyclic_users'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%role%'
  limit 1;

  if constraint_name is not null then
    execute format('alter table public.cyclic_users drop constraint %I', constraint_name);
  end if;

  alter table public.cyclic_users
    add constraint cyclic_users_role_check
    check (role in ('Operario', 'Cajero', 'Validador', 'Supervisor', 'Administrador'));
end $$;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'payment_confirmations'
  ) then
    alter publication supabase_realtime add table public.payment_confirmations;
  end if;
end;
$$;
