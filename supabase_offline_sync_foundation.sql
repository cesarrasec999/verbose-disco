-- Base segura para preparar modo app/offline sin cambiar flujos actuales.
-- Ejecutar en Supabase SQL Editor cuando quieras dejar lista la BD.
-- Todas las columnas son nullable: la web actual sigue insertando igual.

alter table if exists public.cyclic_counts
  add column if not exists client_uuid text null,
  add column if not exists client_device_id text null,
  add column if not exists sync_origin text null;

create unique index if not exists uq_cyclic_counts_client_uuid
  on public.cyclic_counts(client_uuid)
  where client_uuid is not null;

comment on column public.cyclic_counts.client_uuid is
  'Idempotency key del cliente PWA/app para evitar duplicados al sincronizar offline.';
comment on column public.cyclic_counts.client_device_id is
  'Identificador local del dispositivo que genero el registro.';
comment on column public.cyclic_counts.sync_origin is
  'Origen opcional del registro: web, pwa_online, pwa_offline.';

alter table if exists public.audit_counts
  add column if not exists client_uuid text null,
  add column if not exists client_device_id text null,
  add column if not exists sync_origin text null;

create unique index if not exists uq_audit_counts_client_uuid
  on public.audit_counts(client_uuid)
  where client_uuid is not null;

comment on column public.audit_counts.client_uuid is
  'Idempotency key del cliente PWA/app para evitar duplicados al sincronizar offline.';
comment on column public.audit_counts.client_device_id is
  'Identificador local del dispositivo que genero el registro.';
comment on column public.audit_counts.sync_origin is
  'Origen opcional del registro: web, pwa_online, pwa_offline.';

alter table if exists public.general_inventory_counts
  add column if not exists client_uuid text null,
  add column if not exists client_device_id text null,
  add column if not exists sync_origin text null;

create unique index if not exists uq_gi_counts_client_uuid
  on public.general_inventory_counts(client_uuid)
  where client_uuid is not null;

comment on column public.general_inventory_counts.client_uuid is
  'Idempotency key del cliente PWA/app para evitar duplicados al sincronizar offline.';
comment on column public.general_inventory_counts.client_device_id is
  'Identificador local del dispositivo que genero el registro.';
comment on column public.general_inventory_counts.sync_origin is
  'Origen opcional del registro: web, pwa_online, pwa_offline.';

alter table if exists public.general_inventory_recount_counts
  add column if not exists client_uuid text null,
  add column if not exists client_device_id text null,
  add column if not exists sync_origin text null;

create unique index if not exists uq_gi_recount_counts_client_uuid
  on public.general_inventory_recount_counts(client_uuid)
  where client_uuid is not null;

comment on column public.general_inventory_recount_counts.client_uuid is
  'Idempotency key del cliente PWA/app para evitar duplicados al sincronizar offline.';
comment on column public.general_inventory_recount_counts.client_device_id is
  'Identificador local del dispositivo que genero el registro.';
comment on column public.general_inventory_recount_counts.sync_origin is
  'Origen opcional del registro: web, pwa_online, pwa_offline.';

notify pgrst, 'reload schema';
