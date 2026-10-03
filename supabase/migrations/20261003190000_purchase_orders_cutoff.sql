-- Conserva unicamente las OC creadas desde el inicio operativo del modulo.
-- El corte es fijo (03/10/2026, hora de Lima), no avanza cada dia.
-- Las firmas y la configuracion de aprobadores se conservan porque pertenecen
-- a los usuarios y se reutilizan en todas las OC futuras.

set local statement_timeout = '5min';

create or replace function public.skip_purchase_order_before_operational_cutoff()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.po_date < timestamptz '2026-10-03 00:00:00-05' then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_purchase_order_operational_cutoff on public.erp_purchase_orders;
create trigger trg_purchase_order_operational_cutoff
before insert or update on public.erp_purchase_orders
for each row execute function public.skip_purchase_order_before_operational_cutoff();

create or replace function public.skip_orphan_purchase_order_line()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.erp_purchase_orders po
    where po.erp_po_id = new.erp_po_id
      and po.po_date >= timestamptz '2026-10-03 00:00:00-05'
  ) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_purchase_order_line_operational_cutoff on public.erp_purchase_order_lines;
create trigger trg_purchase_order_line_operational_cutoff
before insert or update on public.erp_purchase_order_lines
for each row execute function public.skip_orphan_purchase_order_line();

create temporary table purchase_orders_purge_targets on commit drop as
select erp_po_id
from public.erp_purchase_orders
where po_date < timestamptz '2026-10-03 00:00:00-05';

create temporary table purchase_order_routes_purge_targets on commit drop as
select id
from public.purchase_order_approval_routes
where erp_po_id in (select erp_po_id from purchase_orders_purge_targets);

-- Evita una referencia cruzada si una OC nueva reemplazara una OC antigua.
update public.purchase_order_approval_routes
set replaces_approval_id = null,
    updated_at = now()
where replaces_approval_id in (select id from purchase_order_routes_purge_targets)
  and id not in (select id from purchase_order_routes_purge_targets);

delete from public.purchase_order_pdf_documents
where approval_id in (select id from purchase_order_routes_purge_targets)
   or erp_po_id in (select erp_po_id from purchase_orders_purge_targets);

delete from public.purchase_order_approval_events
where approval_id in (select id from purchase_order_routes_purge_targets);

delete from public.purchase_order_approval_steps
where approval_id in (select id from purchase_order_routes_purge_targets);

delete from public.purchase_order_approval_routes
where id in (select id from purchase_order_routes_purge_targets);

-- Las lineas se eliminan por ON DELETE CASCADE.
delete from public.erp_purchase_orders
where erp_po_id in (select erp_po_id from purchase_orders_purge_targets);

revoke all on function public.skip_purchase_order_before_operational_cutoff() from public;
revoke all on function public.skip_orphan_purchase_order_line() from public;

