-- Additive foundation. No backfill, deletion or overwrite of historical records.
-- Deploy only after testing in isolation; legacy clients keep their current APIs.
-- SECURITY INVOKER intentionally preserves existing RLS. Legacy identity/RLS must
-- be hardened separately before claiming WMS-grade authorization (see rollout doc).
set lock_timeout = '3s';
set statement_timeout = '30s';

create table if not exists public.picking_write_receipts (
  operation_id text primary key check (length(operation_id) between 16 and 120),
  actor_id uuid not null references public.cyclic_users(id),
  kind text not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.picking_write_receipts enable row level security;
create policy picking_receipts_read on public.picking_write_receipts for select
  to anon, authenticated using (true);
create policy picking_receipts_insert on public.picking_write_receipts for insert
  to anon, authenticated with check (true);
grant select, insert on public.picking_write_receipts to anon, authenticated, service_role;

create or replace function public.save_picking_scan_v2(
  p_operation_id text, p_actor_id uuid, p_assignment_id uuid,
  p_product text, p_rows jsonb
) returns jsonb language plpgsql security invoker set search_path = public
set lock_timeout = '3s' set statement_timeout = '10s' as $$
declare
  a picking_assignments%rowtype;
  l picking_request_lines%rowtype;
  u cyclic_users%rowtype;
  receipt picking_write_receipts%rowtype;
  payload jsonb;
  result jsonb;
  inserted jsonb;
  total numeric;
  previous numeric;
  line_key text;
  product text := upper(btrim(p_product));
begin
  if p_actor_id is null or p_assignment_id is null or p_operation_id is null or length(p_operation_id) not between 16 and 120 then
    raise exception 'Identificador de envio invalido';
  end if;
  payload := jsonb_build_object('assignment',p_assignment_id,'product',p_product,'rows',p_rows);
  -- Serialize identical retries, including accidental reuse on a different line.
  perform pg_advisory_xact_lock(hashtextextended(p_operation_id, 9041));
  select * into receipt from picking_write_receipts where operation_id=p_operation_id;
  if found then
    if receipt.actor_id<>p_actor_id or receipt.kind<>'scan' or receipt.payload<>payload then
      raise exception 'Este identificador ya pertenece a otro envio';
    end if;
    return receipt.result;
  end if;
  select * into u from cyclic_users where id=p_actor_id and is_active;
  if not found then raise exception 'Usuario no habilitado'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'Filas invalidas'; end if;
  if jsonb_array_length(p_rows) not between 1 and 50 then raise exception 'Envie entre 1 y 50 ubicaciones'; end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r
    where coalesce(btrim(r->>'location'),'')='' or length(r->>'location')>500
      or jsonb_typeof(r->'qty') is distinct from 'number'
      or (r->>'qty')::numeric<=0 or (r->>'qty')::numeric>1000000000
      or (r->>'qty')::numeric<>round((r->>'qty')::numeric,6)) then
    raise exception 'Complete ubicacion y cantidad positiva';
  end if;
  select line_id into line_key from picking_assignments where id=p_assignment_id;
  if not found then raise exception 'Asignacion no encontrada'; end if;
  -- Same lock order as assignment: line first, then assignment. Locks only one SKU
  -- within one request; unrelated workers never share a global warehouse lock.
  select * into l from picking_request_lines where id=line_key for update;
  select * into a from picking_assignments where id=p_assignment_id for update;
  if not found or a.line_id<>line_key or a.status='cancelado' then
    raise exception 'La asignacion cambio; actualice antes de registrar';
  end if;
  if a.picker_id is distinct from p_actor_id and not
    (a.picker_id is null and a.picker_name=u.full_name) then
    raise exception 'El codigo no esta asignado a este picador';
  end if;
  if product is null or product='' or not (
    coalesce(product=any(array[upper(l.product_code),upper(l.sku),upper(l.barcode)]),false)
    or exists(select 1 from codigos_barra b where (b.upc=product or b.alu=product)
      and upper(b.codsap)=upper(l.product_code))
    or exists(select 1 from cyclic_products p where p.erp_sku=product
      and p.is_active and upper(p.sku)=upper(l.product_code))
  ) then raise exception 'El producto escaneado no coincide con el asignado'; end if;
  select coalesce(sum(s.qty),0) into previous from picking_scans s where s.assignment_id=a.id;
  -- Never silently reconcile a pre-existing mismatch as part of a new scan.
  if previous<>a.picked_qty then
    raise exception 'Avance y registros no coinciden. Solicite revision; no se modifico el historial';
  end if;
  select sum((r->>'qty')::numeric) into total from jsonb_array_elements(p_rows) r;
  if previous+total>a.assigned_qty then raise exception 'Cantidad superior al pendiente asignado'; end if;
  with saved as (
    insert into picking_scans(assignment_id,request_id,line_id,picker_id,picker_name,
      location_code,scanned_product_code,scanned_barcode,qty,is_match)
    select a.id,a.request_id,a.line_id,u.id,u.full_name,upper(btrim(r->>'location')),
      p_product,p_product,(r->>'qty')::numeric,true from jsonb_array_elements(p_rows) r
    returning *
  ) select jsonb_agg(to_jsonb(saved)) into inserted from saved;
  update picking_assignments set picked_qty=previous+total,
    status=case when previous+total=assigned_qty then 'completado' else 'en_proceso' end,
    started_at=coalesce(started_at,now()),
    completed_at=case when previous+total=assigned_qty then now() else null end,
    updated_at=now() where id=a.id returning * into a;
  result := jsonb_build_object('insertedScans',inserted,'assignment',to_jsonb(a),
    'pickedQty',a.picked_qty,'status',a.status);
  insert into picking_write_receipts values(p_operation_id,p_actor_id,'scan',payload,result,now());
  return result;
end $$;

create or replace function public.assign_picking_lines_v2(
  p_operation_id text,p_actor_id uuid,p_picker_id uuid,p_date date,p_line_ids text[]
) returns jsonb language plpgsql security invoker set search_path=public
set lock_timeout='3s' set statement_timeout='15s' as $$
declare
  u cyclic_users%rowtype;
  picker cyclic_users%rowtype;
  l picking_request_lines%rowtype;
  receipt picking_write_receipts%rowtype;
  payload jsonb;
  result jsonb := '[]'::jsonb;
  saved picking_assignments%rowtype;
  assigned numeric;
  ordered_ids text[];
begin
  if p_actor_id is null or p_picker_id is null or p_operation_id is null or length(p_operation_id) not between 16 and 120 or p_date is null
    or coalesce(cardinality(p_line_ids),0) not between 1 and 100
    or array_position(p_line_ids,null) is not null then raise exception 'Lote invalido (maximo 100 codigos)'; end if;
  select array_agg(distinct id order by id) into ordered_ids from unnest(p_line_ids) id;
  payload:=jsonb_build_object('picker',p_picker_id,'date',p_date,'lines',ordered_ids);
  perform pg_advisory_xact_lock(hashtextextended(p_operation_id,9041));
  select * into receipt from picking_write_receipts where operation_id=p_operation_id;
  if found then
    if receipt.actor_id<>p_actor_id or receipt.kind<>'assign' or receipt.payload<>payload then
      raise exception 'Este identificador ya pertenece a otro envio'; end if;
    return receipt.result;
  end if;
  select * into u from cyclic_users where id=p_actor_id and is_active
    and role in ('Administrador','Supervisor','Validador');
  if not found then raise exception 'Usuario no habilitado para asignar'; end if;
  select * into picker from cyclic_users where id=p_picker_id and is_active;
  if not found then raise exception 'Picador no habilitado'; end if;
  if (select count(*) from picking_request_lines where id=any(ordered_ids))<>cardinality(ordered_ids) then
    raise exception 'El lote contiene codigos inexistentes'; end if;
  for l in select * from picking_request_lines where id=any(ordered_ids) order by id for update loop
    if not exists(select 1 from picking_requests r where r.id=l.request_id and r.hidden_at is null) then
      raise exception 'Requerimiento no disponible'; end if;
    select coalesce(sum(assigned_qty),0) into assigned from picking_assignments
      where line_id=l.id and status<>'cancelado';
    if l.qty_requested<=assigned then continue; end if;
    insert into picking_assignments(request_id,line_id,picker_id,picker_name,assigned_qty,
      status,picking_date,created_by,created_by_name)
    values(l.request_id,l.id,picker.id,picker.full_name,l.qty_requested-assigned,
      'pendiente',p_date,u.id,u.full_name) returning * into saved;
    result:=result||jsonb_build_array(to_jsonb(saved));
  end loop;
  insert into picking_write_receipts values(p_operation_id,p_actor_id,'assign',payload,result,now());
  return result;
end $$;

-- A page is bounded even if a caller requests an excessive limit. Cursor includes
-- the UUID so equal creation timestamps do not cause skipped/duplicate records.
create or replace function public.get_picking_tasks_page_v2(
  p_picker_id uuid,p_date date,p_request_id uuid default null,
  p_before_at timestamptz default null,p_before_id uuid default null,p_limit int default 50
) returns table(assignment jsonb,request jsonb,line jsonb)
language sql stable security invoker set search_path=public as $$
  select to_jsonb(a),to_jsonb(r),to_jsonb(l)
  from picking_assignments a join picking_requests r on r.id=a.request_id
  join picking_request_lines l on l.id=a.line_id
  where a.picker_id=p_picker_id and a.status<>'cancelado' and r.hidden_at is null
    and (a.picking_date=p_date or (a.picking_date is null
      and a.created_at>=p_date::timestamp at time zone 'UTC'
      and a.created_at<(p_date+1)::timestamp at time zone 'UTC'))
    and (p_request_id is null or a.request_id=p_request_id)
    and (p_before_at is null or (a.created_at,a.id)<(p_before_at,p_before_id))
  order by a.created_at desc,a.id desc limit least(greatest(coalesce(p_limit,50),1),51);
$$;

create or replace function public.get_picking_scans_page_v2(
  p_picker_id uuid,p_request_id uuid,p_before_at timestamptz default null,
  p_before_id uuid default null,p_limit int default 50
) returns setof public.picking_scans
language sql stable security invoker set search_path=public as $$
  select s.* from picking_scans s where s.picker_id=p_picker_id and s.request_id=p_request_id
    and (p_before_at is null or (s.created_at,s.id)<(p_before_at,p_before_id))
  order by s.created_at desc,s.id desc limit least(greatest(coalesce(p_limit,50),1),51);
$$;

create or replace function public.get_picking_task_totals_v2(p_picker_id uuid,p_date date,p_request_id uuid default null)
returns table(codes bigint,completed bigint,assigned_qty numeric,picked_qty numeric)
language sql stable security invoker set search_path=public as $$
  select count(*),count(*) filter(where a.status='completado'),coalesce(sum(a.assigned_qty),0),coalesce(sum(a.picked_qty),0)
  from picking_assignments a join picking_requests r on r.id=a.request_id
  where a.picker_id=p_picker_id and a.status<>'cancelado' and r.hidden_at is null
    and (a.picking_date=p_date or (a.picking_date is null
      and a.created_at>=p_date::timestamp at time zone 'UTC'
      and a.created_at<(p_date+1)::timestamp at time zone 'UTC'))
    and (p_request_id is null or a.request_id=p_request_id);
$$;

-- Validator list and operator store queue: request headers and small aggregates,
-- never every task/scan just to render a card. Filter BEFORE pagination.
create or replace function public.get_picking_requests_page_v2(
  p_date date,p_picker_id uuid default null,p_source text default null,
  p_destination text default null,p_reason text default null,p_status text default null,
  p_before_at timestamptz default null,p_before_id uuid default null,p_limit int default 50
) returns table(request jsonb,cursor_at timestamptz,tasks bigint,completed bigint,assigned_qty numeric,picked_qty numeric)
language sql stable security invoker set search_path=public as $$
  with page as materialized (
    select r.* from picking_requests r where r.hidden_at is null
      and (p_source is null or r.source_store_code=p_source)
      and (p_destination is null or r.destination_store_code=p_destination)
      and (p_reason is null or r.reason=p_reason)
      and (p_status is null or r.status_code=p_status)
      and (p_before_at is null or (coalesce(r.creation_date,r.created_at),r.id)<(p_before_at,p_before_id))
      and (case when p_picker_id is null then p_date is null or (
          r.creation_date>=p_date::timestamp at time zone 'UTC'
          and r.creation_date<(p_date+1)::timestamp at time zone 'UTC')
        else exists(select 1 from picking_assignments a where a.request_id=r.id
          and a.picker_id=p_picker_id and a.status<>'cancelado'
          and (a.picking_date=p_date or (a.picking_date is null
            and a.created_at>=p_date::timestamp at time zone 'UTC'
            and a.created_at<(p_date+1)::timestamp at time zone 'UTC')))
        end)
    order by coalesce(r.creation_date,r.created_at) desc,r.id desc
    limit least(greatest(coalesce(p_limit,50),1),51)
  )
  select to_jsonb(r),coalesce(r.creation_date,r.created_at),s.tasks,s.completed,s.assigned_qty,s.picked_qty
  from page r cross join lateral (
    select count(*) as tasks,count(*) filter(where a.status='completado') as completed,
      coalesce(sum(a.assigned_qty),0) as assigned_qty,coalesce(sum(a.picked_qty),0) as picked_qty
    from picking_assignments a where a.request_id=r.id and a.status<>'cancelado'
      and (p_picker_id is null or (a.picker_id=p_picker_id
        and (a.picking_date=p_date or (a.picking_date is null
          and a.created_at>=p_date::timestamp at time zone 'UTC'
          and a.created_at<(p_date+1)::timestamp at time zone 'UTC'))))
  ) s order by coalesce(r.creation_date,r.created_at) desc,r.id desc;
$$;

create or replace function public.get_picking_lines_page_v2(
  p_request_id uuid,p_after_id text default null,p_query text default null,
  p_pending_only boolean default false,p_limit int default 50
) returns setof public.picking_request_lines
language sql stable security invoker set search_path=public as $$
  select l.* from picking_request_lines l where l.request_id=p_request_id
    and (p_after_id is null or l.id>p_after_id)
    and (p_query is null or btrim(p_query)='' or l.product_code ilike '%'||p_query||'%'
      or l.description ilike '%'||p_query||'%' or l.barcode=p_query or l.sku=p_query)
    and (not coalesce(p_pending_only,false) or l.qty_requested>l.assigned_qty)
  order by l.id limit least(greatest(coalesce(p_limit,50),1),51);
$$;

revoke all on function public.save_picking_scan_v2(text,uuid,uuid,text,jsonb) from public;
revoke all on function public.assign_picking_lines_v2(text,uuid,uuid,date,text[]) from public;
grant execute on function public.save_picking_scan_v2(text,uuid,uuid,text,jsonb),
  public.assign_picking_lines_v2(text,uuid,uuid,date,text[]),
  public.get_picking_tasks_page_v2(uuid,date,uuid,timestamptz,uuid,int),
  public.get_picking_scans_page_v2(uuid,uuid,timestamptz,uuid,int),
  public.get_picking_task_totals_v2(uuid,date,uuid),
  public.get_picking_requests_page_v2(date,uuid,text,text,text,text,timestamptz,uuid,int),
  public.get_picking_lines_page_v2(uuid,text,text,boolean,int) to anon,authenticated,service_role;
notify pgrst,'reload schema';
