-- Seguridad, fase 4: cierra el acceso PostgREST directo a las particiones que
-- reciben datos durante septiembre de 2026. No activa RLS todavía para evitar
-- un lock de ALTER TABLE mientras hay sincronizaciones en curso.

begin;

set local lock_timeout = '1s';
set local statement_timeout = '10s';

revoke all on table public.erm_2026_09 from anon, authenticated;
revoke all on table public.ivsp_2026_09 from anon, authenticated;
revoke all on table public.ssd_2026_09 from anon, authenticated;

notify pgrst, 'reload schema';

commit;
