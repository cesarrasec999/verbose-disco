-- Seguridad, fase 5: el recálculo masivo de stock de asignaciones pertenece al
-- sincronizador ERP (.53), que usa service_role. PWA/APK/web no llaman estas RPC.

begin;

set local lock_timeout = '1s';
set local statement_timeout = '10s';

revoke all on function public.refresh_cyclic_assignment_stock(date)
  from public, anon, authenticated;
revoke all on function public.refresh_cyclic_assignment_stock(date, uuid)
  from public, anon, authenticated;

grant execute on function public.refresh_cyclic_assignment_stock(date)
  to service_role;
grant execute on function public.refresh_cyclic_assignment_stock(date, uuid)
  to service_role;

commit;
