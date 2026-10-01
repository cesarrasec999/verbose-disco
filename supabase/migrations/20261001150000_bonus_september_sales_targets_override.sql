-- Cierres confirmados por el usuario para el calculo de Bono. No se modifica
-- erp_store_sales_daily: el detalle diario del ERP conserva su historial y el
-- cierre mensual confirmado tiene prioridad solamente en los indicadores Bono.

create table if not exists public.bonus_store_monthly_overrides (
  month_date date not null,
  store_key text not null,
  store_name text not null,
  sales_amount numeric(16,2) not null check (sales_amount >= 0),
  target_amount numeric(16,2) not null check (target_amount >= 0),
  source_name text not null,
  source_reference text,
  updated_at timestamptz not null default now(),
  primary key (month_date, store_key),
  check (month_date = date_trunc('month', month_date)::date)
);

create index if not exists idx_bonus_store_monthly_overrides_month
  on public.bonus_store_monthly_overrides (month_date, store_key);

alter table public.bonus_store_monthly_overrides enable row level security;
drop policy if exists bonus_store_monthly_overrides_select on public.bonus_store_monthly_overrides;
create policy bonus_store_monthly_overrides_select
  on public.bonus_store_monthly_overrides for select
  to anon, authenticated
  using (true);

grant select on public.bonus_store_monthly_overrides to anon, authenticated;
grant select, insert, update, delete on public.bonus_store_monthly_overrides to service_role;

insert into public.bonus_store_monthly_overrides (
  month_date, store_key, store_name, sales_amount, target_amount, source_name, source_reference, updated_at
)
values
  ('2026-09-01','1', 'GPC001 LIM - PERLA',              1025958,1090000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','4', 'GPC002 LIM - SUMINISTRO',          336623, 335000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','5', 'GPC003 LIM - GRUPO',               571963, 560000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','6', 'GPC006 LIM - CALLAO',              141409, 235000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','7', 'GPC007 LIB - TRUJILLO',            579992, 570000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','8', 'GPC008 LAM - CHI. DIAMANTE',       268729, 335000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','9', 'GPC009 LAM - CHI. LEGUIA',         206666, 255000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','10','GPC010 LIM - HUAROCHIRI',          300092, 335000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','11','GPC011 LIM - NARANJAL',            205516, 305000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','12','GPC012 PIU - PIURA',               415408, 550000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','13','GPC013 ARE - EVITAMIENTO',         445080, 550000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','14','GPC014 LIM - SURQUILLO',            89337, 145000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','15','GPC015 JUN - HUANCAYO',            228435, 260000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','16','GPC016 LIM - LURIN',               262188, 225000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','17','GPC017 LIM - ARRIOLA',             145057, 170000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','18','GPC018 LIM - VILLA EL SALVADOR',   115258, 135000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','20','GPC020 LIM - CHORILLOS',           107609, 135000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','21','GPC021 LIM - PUENTE PIEDRA',       137899, 150000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','22','GPC022 LIM - HUACHIPA',            159927, 200000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','23','GPC023 ARE - MIRAFLORES',           40005, 100000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','24','GPC024 CAJ - CAJAMARCA',           112781, 130000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','25','GPC026 ICA - ICA',                 118515, 160000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','19','GPC025 APU - ABANCAY',              63748, 100000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now()),
  ('2026-09-01','27','GPC027 CUS - CUSCO',                81835, 100000,'Cierre confirmado por usuario','Tabla venta/meta septiembre 2026',now())
on conflict (month_date, store_key) do update set
  store_name = excluded.store_name,
  sales_amount = excluded.sales_amount,
  target_amount = excluded.target_amount,
  source_name = excluded.source_name,
  source_reference = excluded.source_reference,
  updated_at = excluded.updated_at;

create or replace function public.get_bonus_period_sources_v2(p_month date)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with daily_sales as (
    select store_key, max(store_name) as store_name, sum(sales_amount) as sales_amount
    from public.erp_store_sales_daily
    where sales_date >= p_month and sales_date < (p_month + interval '1 month')
    group by store_key
  ), effective_sales as (
    select o.store_key, o.store_name, o.sales_amount
    from public.bonus_store_monthly_overrides o
    where o.month_date = p_month
    union all
    select d.store_key, d.store_name, d.sales_amount
    from daily_sales d
    where not exists (
      select 1 from public.bonus_store_monthly_overrides o
      where o.month_date = p_month and o.store_key = d.store_key
    )
  ), effective_targets as (
    select o.store_key, o.target_amount, o.source_name, o.updated_at
    from public.bonus_store_monthly_overrides o
    where o.month_date = p_month
    union all
    select t.store_key, t.target_amount, t.source_name, t.updated_at
    from public.erp_store_sales_targets t
    where t.target_month = p_month
      and not exists (
        select 1 from public.bonus_store_monthly_overrides o
        where o.month_date = p_month and o.store_key = t.store_key
      )
  )
  select jsonb_build_object(
    'sales', coalesce((select jsonb_agg(x order by x.store_key) from effective_sales x), '[]'::jsonb),
    'targets', coalesce((select jsonb_agg(x order by x.updated_at, x.store_key) from effective_targets x), '[]'::jsonb),
    'receipts', coalesce((select jsonb_agg(x) from (
      select destination_store_code, (creation_date at time zone 'America/Lima')::date as creation_date,
             erp_status, count(*) as records
      from public.reception_requests
      where creation_date >= p_month::timestamp at time zone 'America/Lima'
        and creation_date < (p_month + interval '1 month')::timestamp at time zone 'America/Lima'
      group by destination_store_code, (creation_date at time zone 'America/Lima')::date, erp_status
    ) x), '[]'::jsonb),
    'losses', coalesce((select jsonb_agg(x) from (
      select store_code, sum(abs(value_total)) as value_total, count(*) as records
      from public.erp_movements
      where movement_date >= p_month::timestamp at time zone 'America/Lima'
        and movement_date < (p_month + interval '1 month')::timestamp at time zone 'America/Lima'
        and ((source_type='ADJUSTMENT' and reason='15. DESMEDROS') or (source_type='SLIP_OUT' and reason='DESMEDROS'))
      group by store_code
    ) x), '[]'::jsonb)
  );
$$;

create or replace function public.get_bonus_sales_period_v3(p_from date, p_to date)
returns table(store_key text, store_name text, sales_amount numeric)
language sql
stable
security invoker
set search_path = public
as $$
  with daily as (
    select date_trunc('month', sales_date)::date as month_date,
           d.store_key, max(d.store_name) as store_name, sum(d.sales_amount)::numeric as sales_amount
    from public.erp_store_sales_daily d
    where d.sales_date >= p_from and d.sales_date <= p_to
    group by date_trunc('month', sales_date)::date, d.store_key
  ), effective as (
    select o.month_date, o.store_key, o.store_name, o.sales_amount
    from public.bonus_store_monthly_overrides o
    where o.month_date >= date_trunc('month', p_from)::date
      and o.month_date <= date_trunc('month', p_to)::date
    union all
    select d.month_date, d.store_key, d.store_name, d.sales_amount
    from daily d
    where not exists (
      select 1 from public.bonus_store_monthly_overrides o
      where o.month_date = d.month_date and o.store_key = d.store_key
    )
  )
  select e.store_key, max(e.store_name)::text, sum(e.sales_amount)::numeric
  from effective e
  group by e.store_key
  order by e.store_key;
$$;

grant execute on function public.get_bonus_period_sources_v2(date) to anon, authenticated;
grant execute on function public.get_bonus_sales_period_v3(date, date) to anon, authenticated;

notify pgrst, 'reload schema';
