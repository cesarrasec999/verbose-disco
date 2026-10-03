-- Flujo de aprobacion de Ordenes de Compra RMS.
-- No modifica RMS ni elimina rutas/eventos anteriores. Cada cambio material de
-- importe o moneda crea una nueva version y conserva la anterior como superseded.

create table if not exists public.purchase_order_approval_settings (
  id text primary key check (id = 'default'),
  effective_from timestamptz not null,
  pen_medium_from numeric(18, 6) not null default 500,
  pen_high_from numeric(18, 6) not null default 5000,
  usd_medium_from numeric(18, 6) not null default 150,
  usd_high_from numeric(18, 6) not null default 1500,
  updated_at timestamptz not null default now(),
  updated_by uuid null references public.cyclic_users(id) on delete set null
);

insert into public.purchase_order_approval_settings (id, effective_from)
values (
  'default',
  date_trunc('day', now() at time zone 'America/Lima') at time zone 'America/Lima'
)
on conflict (id) do nothing;

create table if not exists public.purchase_order_approvers (
  role_key text not null check (role_key in ('purchasing_lead', 'purchasing_manager', 'finance_manager', 'treasury_lead')),
  user_id uuid not null references public.cyclic_users(id) on delete restrict,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (role_key, user_id),
  unique (user_id)
);

insert into public.purchase_order_approvers (role_key, user_id)
select 'purchasing_lead', id
from public.cyclic_users
where lower(btrim(full_name)) = 'giancarlo mendoza' and is_active = true
order by created_at desc nulls last
limit 1
on conflict do nothing;

insert into public.purchase_order_approvers (role_key, user_id)
select 'purchasing_manager', id
from public.cyclic_users
where lower(btrim(full_name)) = 'david rojas' and is_active = true
order by created_at desc nulls last
limit 1
on conflict do nothing;

insert into public.purchase_order_approvers (role_key, user_id)
select 'finance_manager', id
from public.cyclic_users
where lower(btrim(full_name)) = 'felipe cabellos' and is_active = true
order by created_at desc nulls last
limit 1
on conflict do nothing;

insert into public.purchase_order_approvers (role_key, user_id)
select 'treasury_lead', id
from public.cyclic_users
where lower(btrim(full_name)) = 'cristian cuicapuza' and is_active = true
order by created_at desc nulls last
limit 1
on conflict do nothing;

create table if not exists public.purchase_order_approval_routes (
  id uuid primary key default gen_random_uuid(),
  erp_po_id text not null references public.erp_purchase_orders(erp_po_id) on delete restrict,
  version integer not null,
  route_kind text not null check (route_kind in ('standard', 'replacement')),
  approval_tier text not null check (approval_tier in ('low', 'medium', 'high', 'replacement')),
  currency_code text not null check (currency_code in ('PEN', 'USD')),
  amount_snapshot numeric(18, 6) not null,
  status text not null check (status in ('pending', 'approved', 'rejected', 'cancelled', 'superseded')),
  replaces_approval_id uuid null references public.purchase_order_approval_routes(id) on delete restrict,
  source_changed_at_snapshot timestamptz null,
  rejected_comment text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz null,
  rejected_at timestamptz null,
  rejected_by uuid null references public.cyclic_users(id) on delete set null,
  unique (erp_po_id, version),
  unique (replaces_approval_id)
);

create unique index if not exists idx_po_approval_routes_one_live
  on public.purchase_order_approval_routes (erp_po_id)
  where status in ('pending', 'approved');
create index if not exists idx_po_approval_routes_status_created
  on public.purchase_order_approval_routes (status, created_at desc, id);
create index if not exists idx_po_approval_routes_erp_version
  on public.purchase_order_approval_routes (erp_po_id, version desc);
create index if not exists idx_po_approval_routes_replaces
  on public.purchase_order_approval_routes (replaces_approval_id)
  where replaces_approval_id is not null;

create table if not exists public.purchase_order_approval_steps (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null references public.purchase_order_approval_routes(id) on delete restrict,
  step_order integer not null check (step_order > 0),
  role_key text not null check (role_key in ('purchasing_lead', 'purchasing_manager', 'finance_manager', 'treasury_lead')),
  approver_user_id uuid null references public.cyclic_users(id) on delete restrict,
  approver_name_snapshot text not null,
  status text not null check (status in ('waiting', 'pending', 'approved', 'rejected', 'cancelled')),
  acted_at timestamptz null,
  comment text null,
  created_at timestamptz not null default now(),
  unique (approval_id, step_order),
  unique (approval_id, role_key)
);

create index if not exists idx_po_approval_steps_assignee_status
  on public.purchase_order_approval_steps (approver_user_id, status, approval_id);
create index if not exists idx_po_approval_steps_route_order
  on public.purchase_order_approval_steps (approval_id, step_order);

create table if not exists public.purchase_order_approval_events (
  id bigint generated always as identity primary key,
  approval_id uuid not null references public.purchase_order_approval_routes(id) on delete restrict,
  step_id uuid null references public.purchase_order_approval_steps(id) on delete restrict,
  event_type text not null,
  actor_user_id uuid null references public.cyclic_users(id) on delete set null,
  actor_name text null,
  comment text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_po_approval_events_route_created
  on public.purchase_order_approval_events (approval_id, created_at, id);

create table if not exists public.purchase_order_approval_signatures (
  user_id uuid primary key references public.cyclic_users(id) on delete restrict,
  storage_path text not null unique,
  original_filename text not null,
  mime_type text not null check (mime_type = 'image/png'),
  file_size integer not null check (file_size > 0 and file_size <= 2097152),
  sha256 text not null,
  uploaded_by uuid not null references public.cyclic_users(id) on delete restrict,
  uploaded_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('purchase-order-signatures', 'purchase-order-signatures', false, 2097152, array['image/png'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.purchase_order_approval_settings enable row level security;
alter table public.purchase_order_approvers enable row level security;
alter table public.purchase_order_approval_routes enable row level security;
alter table public.purchase_order_approval_steps enable row level security;
alter table public.purchase_order_approval_events enable row level security;
alter table public.purchase_order_approval_signatures enable row level security;

drop policy if exists po_approval_settings_read on public.purchase_order_approval_settings;
create policy po_approval_settings_read on public.purchase_order_approval_settings
  for select to anon, authenticated using (true);
drop policy if exists po_approvers_read on public.purchase_order_approvers;
create policy po_approvers_read on public.purchase_order_approvers
  for select to anon, authenticated using (true);
drop policy if exists po_approval_routes_read on public.purchase_order_approval_routes;
create policy po_approval_routes_read on public.purchase_order_approval_routes
  for select to anon, authenticated using (true);
drop policy if exists po_approval_steps_read on public.purchase_order_approval_steps;
create policy po_approval_steps_read on public.purchase_order_approval_steps
  for select to anon, authenticated using (true);
drop policy if exists po_approval_events_read on public.purchase_order_approval_events;
create policy po_approval_events_read on public.purchase_order_approval_events
  for select to anon, authenticated using (true);

grant select on public.purchase_order_approval_settings,
  public.purchase_order_approvers,
  public.purchase_order_approval_routes,
  public.purchase_order_approval_steps,
  public.purchase_order_approval_events to anon, authenticated;
grant all on public.purchase_order_approval_settings,
  public.purchase_order_approvers,
  public.purchase_order_approval_routes,
  public.purchase_order_approval_steps,
  public.purchase_order_approval_events,
  public.purchase_order_approval_signatures to service_role;
grant usage, select on sequence public.purchase_order_approval_events_id_seq to service_role;

create or replace function public.purchase_order_role_label(p_role_key text)
returns text
language sql
immutable
parallel safe
as $$
  select case p_role_key
    when 'purchasing_lead' then 'Lider de Compras'
    when 'purchasing_manager' then 'Jefe de Compras'
    when 'finance_manager' then 'Jefe de Finanzas'
    when 'treasury_lead' then 'Lider de Tesoreria'
    else p_role_key
  end
$$;

create or replace function public.purchase_order_session_is_valid(
  p_user_id uuid,
  p_session_token text,
  p_device_id text
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.cyclic_users u
    where u.id = p_user_id
      and u.is_active = true
      and (
        (lower(btrim(u.role::text)) = 'administrador' and lower(btrim(u.full_name)) = 'administrador principal')
        or exists (
          select 1
          from public.cyclic_user_sessions s
          where s.user_id = u.id
            and s.session_token = p_session_token
            and (nullif(btrim(coalesce(p_device_id, '')), '') is null or s.device_id = p_device_id)
            and s.last_seen_at >= now() - interval '12 hours'
        )
      )
  )
$$;

create or replace function public.create_purchase_order_approval_route(
  p_erp_po_id text,
  p_route_kind text default 'standard',
  p_replaces_approval_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.erp_purchase_orders%rowtype;
  v_settings public.purchase_order_approval_settings%rowtype;
  v_route_id uuid;
  v_version integer;
  v_currency text;
  v_tier text;
  v_role text;
  v_step integer := 0;
  v_user_id uuid;
  v_user_name text;
begin
  select * into v_order
  from public.erp_purchase_orders
  where erp_po_id = p_erp_po_id;
  if not found then raise exception 'No se encontro la OC RMS'; end if;

  select * into v_settings
  from public.purchase_order_approval_settings
  where id = 'default';

  v_currency := case when v_order.currency_id = 2 then 'USD' else 'PEN' end;
  if p_route_kind = 'replacement' then
    if p_replaces_approval_id is null then raise exception 'El reemplazo requiere una OC rechazada'; end if;
    v_tier := 'replacement';
  elsif v_currency = 'USD' then
    v_tier := case
      when v_order.total < v_settings.usd_medium_from then 'low'
      when v_order.total < v_settings.usd_high_from then 'medium'
      else 'high'
    end;
  else
    v_tier := case
      when v_order.total < v_settings.pen_medium_from then 'low'
      when v_order.total < v_settings.pen_high_from then 'medium'
      else 'high'
    end;
  end if;

  select coalesce(max(version), 0) + 1 into v_version
  from public.purchase_order_approval_routes
  where erp_po_id = p_erp_po_id;

  insert into public.purchase_order_approval_routes (
    erp_po_id, version, route_kind, approval_tier, currency_code,
    amount_snapshot, status, replaces_approval_id, source_changed_at_snapshot
  ) values (
    p_erp_po_id, v_version, p_route_kind, v_tier, v_currency,
    coalesce(v_order.total, 0), 'pending', p_replaces_approval_id, v_order.source_changed_at
  ) returning id into v_route_id;

  for v_role in
    select role_key
    from (
      select 1 as step_no, 'purchasing_lead'::text as role_key
      where p_route_kind = 'standard'
      union all
      select 2, 'purchasing_manager'
      where p_route_kind = 'standard' and v_tier = 'high'
      union all
      select case when p_route_kind = 'replacement' then 1 when v_tier = 'high' then 3 else 2 end, 'finance_manager'
      where (p_route_kind = 'standard' and v_tier in ('medium', 'high')) or p_route_kind = 'replacement'
      union all
      select case
        when p_route_kind = 'replacement' then 2
        when v_tier = 'low' then 2
        when v_tier = 'medium' then 3
        else 4
      end, 'treasury_lead'
    ) route_roles
    order by step_no
  loop
    v_step := v_step + 1;
    select a.user_id, u.full_name into v_user_id, v_user_name
    from public.purchase_order_approvers a
    join public.cyclic_users u on u.id = a.user_id and u.is_active = true
    where a.role_key = v_role and a.is_active = true
    limit 1;

    if v_user_id is null then
      raise exception 'No existe un usuario activo configurado para %', public.purchase_order_role_label(v_role);
    end if;

    insert into public.purchase_order_approval_steps (
      approval_id, step_order, role_key, approver_user_id,
      approver_name_snapshot, status
    ) values (
      v_route_id, v_step, v_role, v_user_id,
      v_user_name, case when v_step = 1 then 'pending' else 'waiting' end
    );
  end loop;

  insert into public.purchase_order_approval_events (
    approval_id, event_type, comment, metadata
  ) values (
    v_route_id,
    case when p_route_kind = 'replacement' then 'replacement_route_created' else 'route_created' end,
    'Ruta generada automaticamente',
    jsonb_build_object('tier', v_tier, 'currency', v_currency, 'amount', v_order.total, 'version', v_version)
  );

  return v_route_id;
end;
$$;

create or replace function public.sync_purchase_order_approval_route()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_effective_from timestamptz;
  v_current public.purchase_order_approval_routes%rowtype;
begin
  select effective_from into v_effective_from
  from public.purchase_order_approval_settings where id = 'default';

  if new.business_status = 'cancelled' then
    update public.purchase_order_approval_routes
    set status = 'cancelled', updated_at = now()
    where erp_po_id = new.erp_po_id and status = 'pending';
    update public.purchase_order_approval_steps s
    set status = 'cancelled'
    from public.purchase_order_approval_routes r
    where r.id = s.approval_id and r.erp_po_id = new.erp_po_id
      and r.status = 'cancelled' and s.status in ('waiting', 'pending');
    return new;
  end if;

  if coalesce(new.source_created_at, new.po_date, new.synced_at) < v_effective_from then
    return new;
  end if;

  select * into v_current
  from public.purchase_order_approval_routes
  where erp_po_id = new.erp_po_id
    and status in ('pending', 'approved')
  order by version desc
  limit 1;

  if not found then
    perform public.create_purchase_order_approval_route(new.erp_po_id, 'standard', null);
  elsif tg_op = 'UPDATE'
    and (new.total is distinct from old.total or new.currency_id is distinct from old.currency_id)
  then
    update public.purchase_order_approval_routes
    set status = 'superseded', updated_at = now()
    where id = v_current.id;
    update public.purchase_order_approval_steps
    set status = 'cancelled'
    where approval_id = v_current.id and status in ('waiting', 'pending');
    insert into public.purchase_order_approval_events (
      approval_id, event_type, comment, metadata
    ) values (
      v_current.id, 'route_superseded', 'La OC cambio de importe o moneda en RMS',
      jsonb_build_object('old_total', old.total, 'new_total', new.total, 'old_currency_id', old.currency_id, 'new_currency_id', new.currency_id)
    );
    perform public.create_purchase_order_approval_route(new.erp_po_id, 'standard', null);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_sync_purchase_order_approval_route on public.erp_purchase_orders;
create trigger trg_sync_purchase_order_approval_route
after insert or update of total, currency_id, business_status
on public.erp_purchase_orders
for each row execute function public.sync_purchase_order_approval_route();

create or replace function public.get_purchase_orders_workflow_page(
  p_user_id uuid,
  p_status text default 'all',
  p_approval_status text default 'all',
  p_date_from date default null,
  p_date_to date default null,
  p_store_no text default null,
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  erp_po_id text,
  po_number text,
  raw_status_code text,
  business_status text,
  store_no text,
  store_code text,
  store_name text,
  vendor_code text,
  vendor_name text,
  buyer text,
  po_date timestamptz,
  ship_date timestamptz,
  closed_at timestamptz,
  line_count integer,
  qty_ordered numeric,
  qty_received numeric,
  qty_due numeric,
  total numeric,
  currency_id integer,
  synced_at timestamptz,
  approval_id uuid,
  approval_status text,
  approval_tier text,
  route_kind text,
  approval_version integer,
  current_step_role text,
  current_step_name text,
  can_current_user_act boolean,
  has_replacement boolean,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_search text := upper(btrim(coalesce(p_search, '')));
  v_digits text := regexp_replace(coalesce(p_search, ''), '[^0-9]', '', 'g');
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_is_admin boolean;
  v_is_approver boolean;
begin
  select coalesce(lower(btrim(u.role::text)) in ('administrador', 'supervisor'), false)
    into v_is_admin
  from public.cyclic_users u where u.id = p_user_id and u.is_active = true;
  select exists (
    select 1 from public.purchase_order_approvers a
    where a.user_id = p_user_id and a.is_active = true
  ) into v_is_approver;

  return query
  with visible as (
    select po.*,
      route.id as approval_id_value,
      route.status as approval_status_value,
      route.approval_tier,
      route.route_kind,
      route.version as approval_version,
      current_step.role_key as current_step_role,
      current_step.approver_name_snapshot as current_step_name,
      (current_step.approver_user_id = p_user_id and current_step.status = 'pending') as can_act,
      exists (
        select 1 from public.purchase_order_approval_routes replacement
        where replacement.replaces_approval_id = route.id
      ) as has_replacement
    from public.erp_purchase_orders po
    left join lateral (
      select r.* from public.purchase_order_approval_routes r
      where r.erp_po_id = po.erp_po_id
      order by r.version desc limit 1
    ) route on true
    left join lateral (
      select s.* from public.purchase_order_approval_steps s
      where s.approval_id = route.id and s.status = 'pending'
      order by s.step_order limit 1
    ) current_step on true
    where (
      v_is_admin
      or (
        v_is_approver
        and route.id is not null
        and exists (
          select 1 from public.purchase_order_approval_steps own_step
          where own_step.approval_id = route.id and own_step.approver_user_id = p_user_id
        )
      )
    )
  )
  select v.erp_po_id, v.po_number, v.raw_status_code, v.business_status,
         v.store_no, v.store_code, v.store_name, v.vendor_code, v.vendor_name,
         v.buyer, v.po_date, v.ship_date, v.closed_at, v.line_count,
         v.qty_ordered, v.qty_received, v.qty_due, v.total, v.currency_id, v.synced_at,
         v.approval_id_value, v.approval_status_value, v.approval_tier,
         v.route_kind, v.approval_version, v.current_step_role,
         v.current_step_name, v.can_act, v.has_replacement,
         count(*) over() as total_count
  from visible v
  where (coalesce(p_status, 'all') = 'all' or v.business_status = p_status)
    and (
      coalesce(p_approval_status, 'all') = 'all'
      or (p_approval_status = 'unrouted' and v.approval_id_value is null)
      or (p_approval_status = 'action' and v.can_act)
      or v.approval_status_value = p_approval_status
    )
    and (p_date_from is null or v.po_date >= (p_date_from::timestamp at time zone 'America/Lima'))
    and (p_date_to is null or v.po_date < ((p_date_to + 1)::timestamp at time zone 'America/Lima'))
    and (nullif(btrim(coalesce(p_store_no, '')), '') is null or v.store_no = btrim(p_store_no))
    and (
      v_search = ''
      or upper(v.po_number) like '%' || v_search || '%'
      or upper(coalesce(v.vendor_code, '')) like '%' || v_search || '%'
      or upper(coalesce(v.vendor_name, '')) like '%' || v_search || '%'
      or (length(v_digits) >= 5 and v.po_number_suffix = right(v_digits, 5))
      or exists (
        select 1 from public.erp_purchase_order_lines line
        where line.erp_po_id = v.erp_po_id
          and (
            upper(line.product_code) like '%' || v_search || '%'
            or upper(coalesce(line.sku, '')) like '%' || v_search || '%'
            or upper(coalesce(line.barcode, '')) like '%' || v_search || '%'
            or (length(v_digits) >= 5 and line.product_code_suffix = right(v_digits, 5))
          )
      )
    )
  order by v.po_date desc, v.erp_po_id
  limit v_limit offset v_offset;
end;
$$;

create or replace function public.get_purchase_orders_workflow_summary(
  p_user_id uuid,
  p_date_from date default null,
  p_date_to date default null,
  p_store_no text default null,
  p_search text default null
)
returns table (
  total_orders bigint,
  awaiting_my_approval bigint,
  pending_approval bigint,
  approved_orders bigint,
  rejected_orders bigint,
  unrouted_orders bigint,
  total_amount numeric
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_search text := upper(btrim(coalesce(p_search, '')));
  v_digits text := regexp_replace(coalesce(p_search, ''), '[^0-9]', '', 'g');
  v_is_admin boolean;
  v_is_approver boolean;
begin
  select coalesce(lower(btrim(u.role::text)) in ('administrador', 'supervisor'), false)
    into v_is_admin
  from public.cyclic_users u where u.id = p_user_id and u.is_active = true;
  select exists (select 1 from public.purchase_order_approvers a where a.user_id = p_user_id and a.is_active = true)
    into v_is_approver;

  return query
  with visible as (
    select po.*,
      route.id as approval_id,
      route.status as approval_status,
      (current_step.approver_user_id = p_user_id and current_step.status = 'pending') as can_act
    from public.erp_purchase_orders po
    left join lateral (
      select r.* from public.purchase_order_approval_routes r
      where r.erp_po_id = po.erp_po_id order by r.version desc limit 1
    ) route on true
    left join lateral (
      select s.* from public.purchase_order_approval_steps s
      where s.approval_id = route.id and s.status = 'pending' order by s.step_order limit 1
    ) current_step on true
    where (
      v_is_admin
      or (v_is_approver and route.id is not null and exists (
        select 1 from public.purchase_order_approval_steps own_step
        where own_step.approval_id = route.id and own_step.approver_user_id = p_user_id
      ))
    )
      and (p_date_from is null or po.po_date >= (p_date_from::timestamp at time zone 'America/Lima'))
      and (p_date_to is null or po.po_date < ((p_date_to + 1)::timestamp at time zone 'America/Lima'))
      and (nullif(btrim(coalesce(p_store_no, '')), '') is null or po.store_no = btrim(p_store_no))
      and (
        v_search = ''
        or upper(po.po_number) like '%' || v_search || '%'
        or upper(coalesce(po.vendor_code, '')) like '%' || v_search || '%'
        or upper(coalesce(po.vendor_name, '')) like '%' || v_search || '%'
        or (length(v_digits) >= 5 and po.po_number_suffix = right(v_digits, 5))
        or exists (
          select 1 from public.erp_purchase_order_lines line
          where line.erp_po_id = po.erp_po_id
            and (
              upper(line.product_code) like '%' || v_search || '%'
              or upper(coalesce(line.sku, '')) like '%' || v_search || '%'
              or upper(coalesce(line.barcode, '')) like '%' || v_search || '%'
              or (length(v_digits) >= 5 and line.product_code_suffix = right(v_digits, 5))
            )
        )
      )
  )
  select count(*)::bigint,
         count(*) filter (where can_act)::bigint,
         count(*) filter (where approval_status = 'pending')::bigint,
         count(*) filter (where approval_status = 'approved')::bigint,
         count(*) filter (where approval_status = 'rejected')::bigint,
         count(*) filter (where approval_id is null)::bigint,
         coalesce(sum(total), 0)::numeric
  from visible;
end;
$$;

create or replace function public.get_purchase_order_approval_detail(
  p_erp_po_id text,
  p_user_id uuid
)
returns table (
  approval_id uuid,
  version integer,
  route_kind text,
  approval_tier text,
  currency_code text,
  amount_snapshot numeric,
  approval_status text,
  rejected_comment text,
  created_at timestamptz,
  approved_at timestamptz,
  rejected_at timestamptz,
  can_current_user_act boolean,
  can_link_replacement boolean,
  replaces_po_number text,
  replaced_by_po_number text,
  steps jsonb,
  events jsonb
)
language sql
stable
security definer
set search_path = public
as $$
  with route as (
    select r.*
    from public.purchase_order_approval_routes r
    where r.erp_po_id = p_erp_po_id
    order by r.version desc limit 1
  )
  select r.id, r.version, r.route_kind, r.approval_tier, r.currency_code,
         r.amount_snapshot, r.status, r.rejected_comment, r.created_at,
         r.approved_at, r.rejected_at,
         exists (
           select 1 from public.purchase_order_approval_steps s
           where s.approval_id = r.id and s.status = 'pending' and s.approver_user_id = p_user_id
         ),
         r.status = 'rejected' and not exists (
           select 1 from public.purchase_order_approval_routes rr where rr.replaces_approval_id = r.id
         ) and exists (
           select 1 from public.cyclic_users u
           where u.id = p_user_id and u.is_active = true and (
             lower(btrim(u.role::text)) in ('administrador', 'supervisor')
             or exists (
               select 1 from public.purchase_order_approvers a
               where a.user_id = u.id and a.is_active = true and a.role_key in ('purchasing_lead', 'finance_manager')
             )
           )
         ),
         replaced_order.po_number,
         replacement_order.po_number,
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'id', s.id,
             'step_order', s.step_order,
             'role_key', s.role_key,
             'role_label', public.purchase_order_role_label(s.role_key),
             'approver_user_id', s.approver_user_id,
             'approver_name', s.approver_name_snapshot,
             'status', s.status,
             'acted_at', s.acted_at,
             'comment', s.comment
           ) order by s.step_order)
           from public.purchase_order_approval_steps s where s.approval_id = r.id
         ), '[]'::jsonb),
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'id', e.id,
             'event_type', e.event_type,
             'actor_name', e.actor_name,
             'comment', e.comment,
             'metadata', e.metadata,
             'created_at', e.created_at
           ) order by e.created_at, e.id)
           from public.purchase_order_approval_events e where e.approval_id = r.id
         ), '[]'::jsonb)
  from route r
  left join public.purchase_order_approval_routes replaced_route on replaced_route.id = r.replaces_approval_id
  left join public.erp_purchase_orders replaced_order on replaced_order.erp_po_id = replaced_route.erp_po_id
  left join public.purchase_order_approval_routes replacement_route on replacement_route.replaces_approval_id = r.id
  left join public.erp_purchase_orders replacement_order on replacement_order.erp_po_id = replacement_route.erp_po_id
$$;

create or replace function public.act_on_purchase_order_approval(
  p_approval_id uuid,
  p_user_id uuid,
  p_session_token text,
  p_device_id text,
  p_action text,
  p_comment text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_route public.purchase_order_approval_routes%rowtype;
  v_step public.purchase_order_approval_steps%rowtype;
  v_actor_name text;
  v_next_id uuid;
begin
  if not public.purchase_order_session_is_valid(p_user_id, p_session_token, p_device_id) then
    raise exception 'La sesion no es valida o vencio';
  end if;
  if lower(btrim(p_action)) not in ('approve', 'reject') then raise exception 'Accion no valida'; end if;
  if lower(btrim(p_action)) = 'reject' and length(btrim(coalesce(p_comment, ''))) < 3 then
    raise exception 'Indica el motivo del rechazo';
  end if;

  select * into v_route from public.purchase_order_approval_routes where id = p_approval_id for update;
  if not found or v_route.status <> 'pending' then raise exception 'La ruta ya no esta pendiente'; end if;

  select * into v_step
  from public.purchase_order_approval_steps
  where approval_id = p_approval_id and status = 'pending'
  order by step_order limit 1 for update;
  if not found then raise exception 'No existe un paso pendiente'; end if;
  if v_step.approver_user_id is distinct from p_user_id then raise exception 'Esta aprobacion corresponde a otro usuario'; end if;

  select full_name into v_actor_name from public.cyclic_users where id = p_user_id and is_active = true;

  if lower(btrim(p_action)) = 'reject' then
    update public.purchase_order_approval_steps
    set status = 'rejected', acted_at = now(), comment = btrim(p_comment)
    where id = v_step.id;
    update public.purchase_order_approval_steps
    set status = 'cancelled'
    where approval_id = p_approval_id and status = 'waiting';
    update public.purchase_order_approval_routes
    set status = 'rejected', rejected_at = now(), rejected_by = p_user_id,
        rejected_comment = btrim(p_comment), updated_at = now()
    where id = p_approval_id;
    insert into public.purchase_order_approval_events (
      approval_id, step_id, event_type, actor_user_id, actor_name, comment
    ) values (p_approval_id, v_step.id, 'rejected', p_user_id, v_actor_name, btrim(p_comment));
    return jsonb_build_object('status', 'rejected', 'approval_id', p_approval_id);
  end if;

  update public.purchase_order_approval_steps
  set status = 'approved', acted_at = now(), comment = nullif(btrim(coalesce(p_comment, '')), '')
  where id = v_step.id;
  insert into public.purchase_order_approval_events (
    approval_id, step_id, event_type, actor_user_id, actor_name, comment
  ) values (p_approval_id, v_step.id, 'approved', p_user_id, v_actor_name, nullif(btrim(coalesce(p_comment, '')), ''));

  select id into v_next_id
  from public.purchase_order_approval_steps
  where approval_id = p_approval_id and status = 'waiting'
  order by step_order limit 1 for update;

  if v_next_id is null then
    update public.purchase_order_approval_routes
    set status = 'approved', approved_at = now(), updated_at = now()
    where id = p_approval_id;
    insert into public.purchase_order_approval_events (
      approval_id, event_type, actor_user_id, actor_name, comment
    ) values (p_approval_id, 'route_approved', p_user_id, v_actor_name, 'Ruta completada');
    return jsonb_build_object('status', 'approved', 'approval_id', p_approval_id);
  end if;

  update public.purchase_order_approval_steps set status = 'pending' where id = v_next_id;
  update public.purchase_order_approval_routes set updated_at = now() where id = p_approval_id;
  return jsonb_build_object('status', 'pending', 'approval_id', p_approval_id, 'next_step_id', v_next_id);
end;
$$;

create or replace function public.link_purchase_order_replacement(
  p_rejected_approval_id uuid,
  p_new_erp_po_id text,
  p_user_id uuid,
  p_session_token text,
  p_device_id text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original public.purchase_order_approval_routes%rowtype;
  v_target_route public.purchase_order_approval_routes%rowtype;
  v_actor_name text;
  v_new_route_id uuid;
begin
  if not public.purchase_order_session_is_valid(p_user_id, p_session_token, p_device_id) then
    raise exception 'La sesion no es valida o vencio';
  end if;
  if not exists (
    select 1 from public.cyclic_users u
    where u.id = p_user_id and u.is_active = true and (
      lower(btrim(u.role::text)) in ('administrador', 'supervisor')
      or exists (
        select 1 from public.purchase_order_approvers a
        where a.user_id = u.id and a.is_active = true and a.role_key in ('purchasing_lead', 'finance_manager')
      )
    )
  ) then raise exception 'No tienes permiso para relacionar reemplazos'; end if;

  select * into v_original
  from public.purchase_order_approval_routes
  where id = p_rejected_approval_id for update;
  if not found or v_original.status <> 'rejected' then raise exception 'La OC original no esta rechazada'; end if;
  if v_original.erp_po_id = p_new_erp_po_id then raise exception 'La OC de reemplazo debe ser diferente'; end if;
  if exists (select 1 from public.purchase_order_approval_routes where replaces_approval_id = v_original.id) then
    raise exception 'La OC rechazada ya tiene un reemplazo';
  end if;
  if not exists (select 1 from public.erp_purchase_orders where erp_po_id = p_new_erp_po_id) then
    raise exception 'No se encontro la nueva OC en RMS';
  end if;

  select * into v_target_route
  from public.purchase_order_approval_routes
  where erp_po_id = p_new_erp_po_id
  order by version desc limit 1 for update;

  if found then
    if exists (
      select 1 from public.purchase_order_approval_steps
      where approval_id = v_target_route.id and status in ('approved', 'rejected')
    ) then raise exception 'La nueva OC ya tiene acciones registradas y no puede convertirse en reemplazo'; end if;
    if v_target_route.status = 'pending' then
      update public.purchase_order_approval_routes set status = 'superseded', updated_at = now() where id = v_target_route.id;
      update public.purchase_order_approval_steps set status = 'cancelled'
      where approval_id = v_target_route.id and status in ('waiting', 'pending');
      insert into public.purchase_order_approval_events (approval_id, event_type, actor_user_id, comment)
      values (v_target_route.id, 'route_superseded', p_user_id, 'Convertida en OC de reemplazo');
    end if;
  end if;

  v_new_route_id := public.create_purchase_order_approval_route(p_new_erp_po_id, 'replacement', v_original.id);
  select full_name into v_actor_name from public.cyclic_users where id = p_user_id;
  insert into public.purchase_order_approval_events (
    approval_id, event_type, actor_user_id, actor_name, comment,
    metadata
  ) values (
    v_original.id, 'replacement_linked', p_user_id, v_actor_name,
    'Se relaciono una nueva OC de reemplazo',
    jsonb_build_object('replacement_approval_id', v_new_route_id, 'replacement_erp_po_id', p_new_erp_po_id)
  );
  return v_new_route_id;
end;
$$;

revoke all on function public.purchase_order_session_is_valid(uuid, text, text) from public;
revoke all on function public.create_purchase_order_approval_route(text, text, uuid) from public;
revoke all on function public.sync_purchase_order_approval_route() from public;
revoke all on function public.act_on_purchase_order_approval(uuid, uuid, text, text, text, text) from public;
revoke all on function public.link_purchase_order_replacement(uuid, text, uuid, text, text) from public;

grant execute on function public.get_purchase_orders_workflow_page(uuid, text, text, date, date, text, text, integer, integer)
  to anon, authenticated, service_role;
grant execute on function public.get_purchase_orders_workflow_summary(uuid, date, date, text, text)
  to anon, authenticated, service_role;
grant execute on function public.get_purchase_order_approval_detail(text, uuid)
  to anon, authenticated, service_role;
grant execute on function public.act_on_purchase_order_approval(uuid, uuid, text, text, text, text)
  to anon, authenticated;
grant execute on function public.link_purchase_order_replacement(uuid, text, uuid, text, text)
  to anon, authenticated;

-- Crea rutas solo para las OC del dia de activacion en adelante. No toca el
-- historial anterior, y es idempotente si la migracion se reintenta.
do $$
declare
  v_order record;
  v_effective_from timestamptz;
begin
  select effective_from into v_effective_from
  from public.purchase_order_approval_settings where id = 'default';
  for v_order in
    select po.erp_po_id
    from public.erp_purchase_orders po
    where po.business_status <> 'cancelled'
      and coalesce(po.source_created_at, po.po_date, po.synced_at) >= v_effective_from
      and not exists (
        select 1 from public.purchase_order_approval_routes r where r.erp_po_id = po.erp_po_id
      )
    order by po.po_date, po.erp_po_id
  loop
    perform public.create_purchase_order_approval_route(v_order.erp_po_id, 'standard', null);
  end loop;
end;
$$;

notify pgrst, 'reload schema';
