-- Inventarios generales RASECORP
-- Ejecutar en Supabase SQL Editor.
-- Usa las tablas maestras ya sincronizadas: stores, cyclic_products, codigos_barra, stock_general.

create extension if not exists pgcrypto;

create table if not exists general_inventory_sessions (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  name text not null,
  status text not null default 'planned'
    check (status in ('planned', 'open', 'frozen', 'finished', 'cancelled')),
  scheduled_date date,
  created_by uuid references cyclic_users(id),
  frozen_by uuid references cyclic_users(id),
  stock_frozen_at timestamptz,
  frozen_total_value numeric(14,2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists idx_gi_sessions_status on general_inventory_sessions(status);
create index if not exists idx_gi_sessions_store on general_inventory_sessions(store_id);

create table if not exists general_inventory_operators (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text not null unique,
  password text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table general_inventory_operators add column if not exists password text;

create table if not exists general_inventory_session_operators (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references general_inventory_sessions(id) on delete cascade,
  operator_id uuid not null references general_inventory_operators(id),
  status text not null default 'active' check (status in ('active', 'blocked')),
  joined_at timestamptz not null default now(),
  unique (session_id, operator_id)
);

create index if not exists idx_gi_session_operators_session on general_inventory_session_operators(session_id);

create table if not exists general_inventory_locations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references general_inventory_sessions(id) on delete cascade,
  location_code text not null,
  ticket text,
  zone text,
  zone_ref text,
  lineal text,
  reference text,
  full_location text,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (session_id, location_code)
);

alter table general_inventory_locations add column if not exists ticket text;
alter table general_inventory_locations add column if not exists zone text;
alter table general_inventory_locations add column if not exists zone_ref text;
alter table general_inventory_locations add column if not exists lineal text;
alter table general_inventory_locations add column if not exists reference text;
alter table general_inventory_locations add column if not exists full_location text;

create index if not exists idx_gi_locations_session_code on general_inventory_locations(session_id, location_code);
create index if not exists idx_gi_locations_session_zone on general_inventory_locations(session_id, zone);
create index if not exists idx_gi_locations_session_zone_ref on general_inventory_locations(session_id, zone_ref);
create index if not exists idx_gi_locations_session_lineal on general_inventory_locations(session_id, lineal);

create table if not exists general_inventory_non_inventory_products (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references general_inventory_sessions(id) on delete cascade,
  product_id uuid references cyclic_products(id),
  sku text not null,
  description text,
  reason text,
  created_at timestamptz not null default now(),
  unique (session_id, sku)
);

create index if not exists idx_gi_noninv_session_sku on general_inventory_non_inventory_products(session_id, sku);

create table if not exists general_inventory_stock_snapshot (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references general_inventory_sessions(id) on delete cascade,
  product_id uuid not null references cyclic_products(id),
  sku text not null,
  description text,
  unit text,
  system_stock numeric(14,3) not null default 0,
  cost numeric(14,6) not null default 0,
  system_value numeric(14,2) generated always as (round((system_stock * cost)::numeric, 2)) stored,
  manually_adjusted boolean not null default false,
  adjusted_by uuid references cyclic_users(id),
  adjusted_at timestamptz,
  adjustment_note text,
  frozen_at timestamptz not null default now(),
  unique (session_id, product_id)
);

create index if not exists idx_gi_snapshot_session_sku on general_inventory_stock_snapshot(session_id, sku);

create table if not exists general_inventory_counts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references general_inventory_sessions(id) on delete cascade,
  operator_id uuid not null references general_inventory_operators(id),
  location_id uuid not null references general_inventory_locations(id),
  location_code text not null,
  product_id uuid not null references cyclic_products(id),
  sku text not null,
  description text,
  unit text,
  quantity numeric(14,3) not null check (quantity > 0),
  cost_snapshot numeric(14,6) not null default 0,
  counted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_gi_counts_session_recent on general_inventory_counts(session_id, counted_at desc);
create index if not exists idx_gi_counts_session_sku on general_inventory_counts(session_id, sku);
create index if not exists idx_gi_counts_operator on general_inventory_counts(operator_id);
create index if not exists idx_gi_counts_location on general_inventory_counts(location_id);

create table if not exists general_inventory_recount_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references general_inventory_sessions(id) on delete cascade,
  product_id uuid not null references cyclic_products(id),
  location_id uuid references general_inventory_locations(id),
  location_code text,
  ticket text,
  zone text,
  zone_ref text,
  lineal text,
  full_location text,
  recount_type text not null check (recount_type in ('surplus', 'missing')),
  sku text not null,
  description text,
  unit text,
  system_stock numeric(14,3) not null default 0,
  counted_qty numeric(14,3) not null default 0,
  diff_qty numeric(14,3) not null default 0,
  cost_snapshot numeric(14,6) not null default 0,
  value_diff numeric(14,2) not null default 0,
  assigned_operator_id uuid references general_inventory_operators(id),
  assigned_by uuid references cyclic_users(id),
  status text not null default 'assigned' check (status in ('assigned', 'counted', 'reviewed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, product_id, location_code, recount_type)
);

create index if not exists idx_gi_recount_items_session on general_inventory_recount_items(session_id);
create index if not exists idx_gi_recount_items_operator on general_inventory_recount_items(assigned_operator_id);
create index if not exists idx_gi_recount_items_location on general_inventory_recount_items(session_id, location_code);

alter table general_inventory_recount_items add column if not exists ticket text;
alter table general_inventory_recount_items add column if not exists zone text;
alter table general_inventory_recount_items add column if not exists zone_ref text;
alter table general_inventory_recount_items add column if not exists lineal text;
alter table general_inventory_recount_items add column if not exists full_location text;

create table if not exists general_inventory_recount_counts (
  id uuid primary key default gen_random_uuid(),
  recount_item_id uuid not null references general_inventory_recount_items(id) on delete cascade,
  session_id uuid not null references general_inventory_sessions(id) on delete cascade,
  operator_id uuid not null references general_inventory_operators(id),
  location_id uuid references general_inventory_locations(id),
  location_code text,
  product_id uuid references cyclic_products(id),
  sku text,
  description text,
  unit text,
  quantity numeric(14,3) not null check (quantity >= 0),
  cost_snapshot numeric(14,6) not null default 0,
  note text,
  counted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (recount_item_id)
);

create index if not exists idx_gi_recount_counts_item on general_inventory_recount_counts(recount_item_id);
create index if not exists idx_gi_recount_counts_session on general_inventory_recount_counts(session_id);

alter table general_inventory_recount_counts add column if not exists location_id uuid references general_inventory_locations(id);
alter table general_inventory_recount_counts add column if not exists location_code text;
alter table general_inventory_recount_counts add column if not exists product_id uuid references cyclic_products(id);
alter table general_inventory_recount_counts add column if not exists sku text;
alter table general_inventory_recount_counts add column if not exists description text;
alter table general_inventory_recount_counts add column if not exists unit text;
alter table general_inventory_recount_counts add column if not exists cost_snapshot numeric(14,6) not null default 0;

create index if not exists idx_gi_recount_counts_sku on general_inventory_recount_counts(session_id, sku);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'general_inventory_recount_counts_recount_item_id_key'
  ) then
    delete from general_inventory_recount_counts
    where id in (
      select id
      from (
        select
          id,
          row_number() over (
            partition by recount_item_id
            order by updated_at desc, counted_at desc, id desc
          ) as rn
        from general_inventory_recount_counts
      ) duplicated
      where duplicated.rn > 1
    );

    alter table general_inventory_recount_counts
      add constraint general_inventory_recount_counts_recount_item_id_key unique (recount_item_id);
  end if;
end;
$$;

create table if not exists general_inventory_item_observations (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references general_inventory_sessions(id) on delete cascade,
  product_id uuid not null references cyclic_products(id),
  observation text,
  updated_by uuid references cyclic_users(id),
  updated_at timestamptz not null default now(),
  unique (session_id, product_id)
);

create or replace function freeze_general_inventory_stock(
  p_session_id uuid,
  p_user_id uuid default null
)
returns integer
language plpgsql
security definer
as $$
declare
  v_store_id uuid;
  v_sede text;
  v_inserted integer;
begin
  select s.store_id, coalesce(nullif(st.erp_sede, ''), st.name)
    into v_store_id, v_sede
  from general_inventory_sessions s
  join stores st on st.id = s.store_id
  where s.id = p_session_id
    and s.status in ('planned', 'open', 'frozen');

  if v_store_id is null then
    raise exception 'Sesion no encontrada o no disponible para congelar';
  end if;

  delete from general_inventory_stock_snapshot
  where session_id = p_session_id;

  insert into general_inventory_stock_snapshot (
    session_id,
    product_id,
    sku,
    description,
    unit,
    system_stock,
    cost,
    frozen_at
  )
  select
    p_session_id,
    p.id,
    p.sku,
    p.description,
    p.unit,
    coalesce(sg.stock, 0)::numeric,
    coalesce(sg.costo, p.cost, 0)::numeric,
    now()
  from stock_general sg
  join cyclic_products p
    on p.sku = sg.codsap
  where sg.sede = v_sede
    and p.is_active = true
    and not exists (
      select 1
      from general_inventory_non_inventory_products ni
      where ni.session_id = p_session_id
        and ni.sku = p.sku
    );

  get diagnostics v_inserted = row_count;

  update general_inventory_sessions
  set status = 'frozen',
      frozen_by = p_user_id,
      stock_frozen_at = now(),
      frozen_total_value = coalesce((
        select round(sum(system_value)::numeric, 2)
        from general_inventory_stock_snapshot
        where session_id = p_session_id
      ), 0),
      updated_at = now()
  where id = p_session_id;

  return v_inserted;
end;
$$;
