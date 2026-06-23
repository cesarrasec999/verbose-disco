-- Elimina por completo el modulo Confirmaciones (tabla, funcion, trigger,
-- policies de storage, bucket y publicacion realtime).
-- Ejecutar una vez en el SQL Editor de Supabase. Es idempotente.
-- ADVERTENCIA: esto borra para siempre el historial de confirmaciones de pago
-- y las fotos de comprobantes asociadas. No hay vuelta atras.

-- 1. Quitar la tabla de la publicacion realtime (si esta agregada)
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'payment_confirmations'
  ) then
    alter publication supabase_realtime drop table public.payment_confirmations;
  end if;
end $$;

-- 2. Policies de storage del bucket payment-confirmations
drop policy if exists payment_confirmations_public_read on storage.objects;
drop policy if exists payment_confirmations_public_insert on storage.objects;

-- 3. Objetos y bucket de storage ya se borraron via la Storage API (no se
-- puede hacer DELETE directo sobre storage.objects/storage.buckets por SQL)

-- 4. Trigger y funcion de updated_at
drop trigger if exists trg_payment_confirmations_updated_at on public.payment_confirmations;
drop function if exists public.touch_payment_confirmations_updated_at();

-- 5. Tabla principal (cascade por los indices/constraints que dependen de ella)
drop table if exists public.payment_confirmations cascade;
