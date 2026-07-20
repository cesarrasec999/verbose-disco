-- Agrega "Desviacion sobre la venta" al reporte de inventarios generales
-- finalizados (inventarios > Reportes): abs(diferencia neta valorizada) /
-- ventas de la tienda en el periodo entre el inventario ANTERIOR y este.
--
-- "Periodo entre inventarios" = [fecha en que finalizo el inventario
-- anterior de esa tienda, fecha en que finalizo ESTE inventario menos 1
-- dia] (el dia que finaliza el anterior ya cuenta como parte del periodo
-- nuevo, confirmado con el usuario con el ejemplo de GPC001 PERLA:
-- finalizo el 16-feb, el siguiente finalizo el 31-may, periodo de ventas
-- = 16-feb al 30-may).
--
-- El "inventario anterior" se resuelve con LAG() sobre TODO el historial
-- de sesiones finalizadas de la tienda (no solo las del rango de fechas
-- pedido al RPC), para que un inventario que cae al principio del rango
-- filtrado igual encuentre el anterior aunque ese anterior haya finalizado
-- antes del rango.
--
-- Hoy (2026-07-20) todas las tiendas tienen exactamente 1 sesion
-- finalizada (es la primera ronda de inventario general en la app), asi
-- que NINGUNA tiene un "inventario anterior" real todavia -- por eso el
-- usuario dio a mano la fecha del ultimo inventario FISICO (pre-app) de
-- cada tienda, para usar como arranque del periodo de ventas del primer
-- inventario de cada una. A futuro, en cuanto una tienda tenga una 2da
-- sesion finalizada, el LAG() la va a usar automaticamente y esta fecha
-- manual deja de aplicarle a esa tienda (solo es fallback para cuando no
-- hay sesion anterior en la app).
--
-- GPC025 (Abancay) y GPC026 (Ica) son "desde su apertura" (sin inventario
-- fisico previo conocido) -- se dejan sin fecha base (NULL), lo que en la
-- practica no acota el piso: erp_store_sales_daily arranca el 2026-05-02
-- para todas las tiendas por igual (ahi empezo el sync), asi que no hay
-- ventas mas viejas que sumar de todos modos.
-- CD-GPC (centro de distribucion) no tiene ventas -- sin fecha base,
-- la suma de ventas da 0 y la desviacion queda NULL (se muestra "-").
--
-- CREATE OR REPLACE no permite agregar columnas al final de un RETURNS
-- TABLE existente (Postgres lo trata como cambio de tipo de retorno) --
-- hay que borrar la funcion primero.
drop function if exists public.get_finished_general_inventory_report(date, date);

create function public.get_finished_general_inventory_report(
  p_date_from date,
  p_date_to date
)
returns table (
  session_id uuid,
  inventory_name text,
  store_id uuid,
  store_name text,
  scheduled_date date,
  finished_at timestamptz,
  finished_by_name text,
  stock_frozen_at timestamptz,
  duration_minutes numeric,
  total_codes bigint,
  counted_codes bigint,
  ok_codes bigint,
  no_counted_codes bigint,
  surplus_codes bigint,
  missing_codes bigint,
  difference_codes bigint,
  system_value numeric,
  counted_value numeric,
  surplus_value numeric,
  missing_value numeric,
  net_value_diff numeric,
  abs_value_diff numeric,
  eri_pct numeric,
  sales_in_period numeric,
  deviation_over_sales_pct numeric
)
language sql
stable
as $$
with finished_sessions as (
  select
    s.id,
    s.store_id,
    s.name,
    s.scheduled_date,
    s.created_at,
    s.finished_at,
    s.stock_frozen_at,
    coalesce(s.validation_enabled, false) as validation_enabled
  from public.general_inventory_sessions s
  where s.status = 'finished'
    and s.finished_at is not null
    and s.finished_at::date >= p_date_from
    and s.finished_at::date <= p_date_to
),
non_inventory as (
  select fs.id as session_id, upper(trim(ni.sku)) as sku
  from finished_sessions fs
  join public.general_inventory_non_inventory_products ni
    on ni.session_id = fs.id
  union
  select fs.id as session_id, upper(trim(ni.sku)) as sku
  from finished_sessions fs
  cross join public.cyclic_non_inventory_products ni
  where ni.is_active = true
),
snapshot_base as (
  select
    s.session_id,
    s.product_id,
    max(s.sku) as sku,
    max(s.description) as description,
    max(s.unit) as unit,
    max(coalesce(s.system_stock, 0))::numeric as system_stock,
    max(coalesce(s.cost, 0))::numeric as cost
  from public.general_inventory_stock_snapshot s
  join finished_sessions fs on fs.id = s.session_id
  where not exists (
    select 1 from non_inventory ni
    where ni.session_id = s.session_id
      and ni.sku = upper(trim(s.sku))
  )
  group by s.session_id, s.product_id
),
count_totals as (
  select
    c.session_id,
    c.product_id,
    max(c.sku) as sku,
    max(c.description) as description,
    max(c.unit) as unit,
    sum(coalesce(c.quantity, 0))::numeric as counted_original,
    max(coalesce(c.cost_snapshot, 0))::numeric as cost_snapshot
  from public.general_inventory_counts c
  join finished_sessions fs on fs.id = c.session_id
  where not exists (
    select 1 from non_inventory ni
    where ni.session_id = c.session_id
      and ni.sku = upper(trim(c.sku))
  )
  group by c.session_id, c.product_id
),
base_products as (
  select session_id, product_id from snapshot_base
  union
  select session_id, product_id from count_totals
),
recount_item_times as (
  select
    ri.session_id,
    ri.product_id,
    ri.id as item_id,
    max(coalesce(rc.updated_at, rc.counted_at, ri.updated_at, ri.created_at)) as latest_at
  from public.general_inventory_recount_items ri
  join finished_sessions fs on fs.id = ri.session_id
  join public.general_inventory_recount_counts rc
    on rc.recount_item_id = ri.id
   and rc.session_id = ri.session_id
  where ri.status = 'counted'
    and not exists (
      select 1 from non_inventory ni
      where ni.session_id = rc.session_id
        and ni.sku = upper(trim(rc.sku))
    )
  group by ri.session_id, ri.product_id, ri.id
),
latest_recount_items as (
  select distinct on (session_id, product_id)
    session_id,
    product_id,
    item_id
  from recount_item_times
  order by session_id, product_id, latest_at desc nulls last, item_id desc
),
recount_totals as (
  select
    lri.session_id,
    lri.product_id,
    sum(coalesce(rc.quantity, 0))::numeric as recounted_qty
  from latest_recount_items lri
  join public.general_inventory_recount_counts rc
    on rc.recount_item_id = lri.item_id
   and rc.session_id = lri.session_id
  group by lri.session_id, lri.product_id
),
validation_item_times as (
  select
    vi.session_id,
    vi.product_id,
    vi.id as item_id,
    max(coalesce(vc.updated_at, vc.counted_at, vi.updated_at, vi.created_at)) as latest_at
  from public.general_inventory_validation_items vi
  join finished_sessions fs on fs.id = vi.session_id and fs.validation_enabled = true
  join public.general_inventory_validation_counts vc
    on vc.validation_item_id = vi.id
   and vc.session_id = vi.session_id
  where vi.status = 'counted'
    and not exists (
      select 1 from non_inventory ni
      where ni.session_id = vc.session_id
        and ni.sku = upper(trim(vc.sku))
    )
  group by vi.session_id, vi.product_id, vi.id
),
latest_validation_items as (
  select distinct on (session_id, product_id)
    session_id,
    product_id,
    item_id
  from validation_item_times
  order by session_id, product_id, latest_at desc nulls last, item_id desc
),
validation_totals as (
  select
    lvi.session_id,
    lvi.product_id,
    sum(coalesce(vc.quantity, 0))::numeric as validation_qty
  from latest_validation_items lvi
  join public.general_inventory_validation_counts vc
    on vc.validation_item_id = lvi.item_id
   and vc.session_id = lvi.session_id
  group by lvi.session_id, lvi.product_id
),
assembled as (
  select
    bp.session_id,
    bp.product_id,
    coalesce(sb.sku, ct.sku, cp.sku) as sku,
    coalesce(sb.system_stock, 0)::numeric as system_stock,
    coalesce(vt.validation_qty, rt.recounted_qty, ct.counted_original, 0)::numeric as counted,
    coalesce(sb.cost, ct.cost_snapshot, cp.cost, 0)::numeric as cost
  from base_products bp
  left join snapshot_base sb
    on sb.session_id = bp.session_id
   and sb.product_id = bp.product_id
  left join count_totals ct
    on ct.session_id = bp.session_id
   and ct.product_id = bp.product_id
  left join recount_totals rt
    on rt.session_id = bp.session_id
   and rt.product_id = bp.product_id
  left join validation_totals vt
    on vt.session_id = bp.session_id
   and vt.product_id = bp.product_id
  left join public.cyclic_products cp
    on cp.id = bp.product_id
),
filtered as (
  select *
  from assembled
  where sku is not null
    and not (system_stock <= 0 and counted <= 0)
),
session_summary as (
  select
    session_id,
    count(*)::bigint as total_codes,
    count(*) filter (where counted > 0)::bigint as counted_codes,
    count(*) filter (where counted > 0 and counted = system_stock)::bigint as ok_codes,
    count(*) filter (where counted <= 0)::bigint as no_counted_codes,
    count(*) filter (where counted > system_stock)::bigint as surplus_codes,
    count(*) filter (where counted < system_stock)::bigint as missing_codes,
    count(*) filter (where counted <> system_stock)::bigint as difference_codes,
    coalesce(sum(system_stock * cost), 0)::numeric as system_value,
    coalesce(sum(counted * cost), 0)::numeric as counted_value,
    coalesce(sum(greatest(counted - system_stock, 0) * cost), 0)::numeric as surplus_value,
    coalesce(sum(least(counted - system_stock, 0) * cost), 0)::numeric as missing_value,
    coalesce(sum((counted - system_stock) * cost), 0)::numeric as net_value_diff,
    coalesce(sum(abs(counted - system_stock) * cost), 0)::numeric as abs_value_diff
  from filtered
  group by session_id
),
-- --------------------------------------------------------------------------
-- Desviacion sobre la venta: periodo = [fin del inventario anterior de la
-- MISMA tienda (o la fecha manual si no hay uno anterior en la app), fin de
-- ESTE inventario menos 1 dia].
all_finished_by_store as (
  select
    s.id as session_id,
    s.store_id,
    st.name as store_name,
    s.finished_at,
    lag(s.finished_at) over (partition by s.store_id order by s.finished_at) as prev_finished_at
  from public.general_inventory_sessions s
  join public.stores st on st.id = s.store_id
  where s.status = 'finished'
    and s.finished_at is not null
),
manual_baseline as (
  select * from (values
    ('GPC001 LIM - PERLA', date '2026-02-16'),
    ('GPC002 LIM - SUMINISTRO', date '2026-01-26'),
    ('GPC003 LIM - GRUPO', date '2026-02-02'),
    ('GPC006 LIM - CALLAO', date '2026-03-16'),
    ('GPC007 LIB - TRUJILLO', date '2026-02-09'),
    ('GPC008 LAM - CHI. DIAMANTE', date '2026-03-09'),
    ('GPC009 LAM - CHI. LEGUIA', date '2026-03-09'),
    ('GPC010 LIM - HUAROCHIRI', date '2026-01-19'),
    ('GPC011 LIM - NARANJAL', date '2026-03-02'),
    ('GPC014 LIM - SURQUILLO', date '2026-03-09'),
    ('GPC015 JUN - HUANCAYO', date '2026-03-16'),
    ('GPC017 LIM - ARRIOLA', date '2026-03-09'),
    ('GPC020 LIM - CHORILLOS', date '2026-02-09'),
    ('GPC023 ARE - MIRAFLORES', date '2026-03-02')
  ) as t(store_name, baseline_date)
),
period_bounds as (
  select
    afs.session_id,
    afs.store_name,
    coalesce(afs.prev_finished_at::date, mb.baseline_date) as period_start,
    (afs.finished_at::date - 1) as period_end
  from all_finished_by_store afs
  left join manual_baseline mb on mb.store_name = afs.store_name
),
sales_by_session as (
  select
    pb.session_id,
    sum(esd.sales_amount)::numeric as sales_in_period
  from period_bounds pb
  left join public.erp_store_sales_daily esd
    on esd.store_name = pb.store_name
   and esd.sales_date >= coalesce(pb.period_start, date '0001-01-01')
   and esd.sales_date <= pb.period_end
  group by pb.session_id
)
select
  fs.id as session_id,
  fs.name as inventory_name,
  fs.store_id,
  st.name as store_name,
  fs.scheduled_date,
  fs.finished_at,
  ''::text as finished_by_name,
  fs.stock_frozen_at,
  round((extract(epoch from (fs.finished_at - fs.created_at)) / 60)::numeric, 2) as duration_minutes,
  coalesce(ss.total_codes, 0)::bigint as total_codes,
  coalesce(ss.counted_codes, 0)::bigint as counted_codes,
  coalesce(ss.ok_codes, 0)::bigint as ok_codes,
  coalesce(ss.no_counted_codes, 0)::bigint as no_counted_codes,
  coalesce(ss.surplus_codes, 0)::bigint as surplus_codes,
  coalesce(ss.missing_codes, 0)::bigint as missing_codes,
  coalesce(ss.difference_codes, 0)::bigint as difference_codes,
  round(coalesce(ss.system_value, 0), 2) as system_value,
  round(coalesce(ss.counted_value, 0), 2) as counted_value,
  round(coalesce(ss.surplus_value, 0), 2) as surplus_value,
  round(coalesce(ss.missing_value, 0), 2) as missing_value,
  round(coalesce(ss.net_value_diff, 0), 2) as net_value_diff,
  round(coalesce(ss.abs_value_diff, 0), 2) as abs_value_diff,
  case
    when coalesce(ss.total_codes, 0) > 0
      then round((coalesce(ss.ok_codes, 0)::numeric / ss.total_codes::numeric) * 100, 2)
    else 0
  end as eri_pct,
  round(coalesce(sbs.sales_in_period, 0), 2) as sales_in_period,
  case
    when coalesce(sbs.sales_in_period, 0) > 0
      then round((abs(coalesce(ss.net_value_diff, 0)) / sbs.sales_in_period) * 100, 2)
    else null
  end as deviation_over_sales_pct
from finished_sessions fs
left join session_summary ss on ss.session_id = fs.id
left join sales_by_session sbs on sbs.session_id = fs.id
left join public.stores st on st.id = fs.store_id
order by fs.finished_at desc, st.name, fs.name;
$$;

grant execute on function public.get_finished_general_inventory_report(date, date) to anon, authenticated;

notify pgrst, 'reload schema';
