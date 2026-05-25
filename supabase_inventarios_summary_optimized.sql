-- Resumen optimizado para Inventarios Generales.
-- Seguro para ejecutar: no borra ni actualiza registros de conteo/reconteo/validacion.
-- Crea indices idempotentes y una funcion de solo lectura para que la web no tenga que
-- descargar tablas completas y recalcular el resumen en el navegador.

create index if not exists idx_gi_counts_session_product
  on public.general_inventory_counts(session_id, product_id);

create index if not exists idx_gi_counts_session_sku
  on public.general_inventory_counts(session_id, sku);

create index if not exists idx_gi_recount_counts_session_item
  on public.general_inventory_recount_counts(session_id, recount_item_id);

create index if not exists idx_gi_recount_items_session_product_status
  on public.general_inventory_recount_items(session_id, product_id, status);

create index if not exists idx_gi_validation_counts_session_item
  on public.general_inventory_validation_counts(session_id, validation_item_id);

create index if not exists idx_gi_validation_items_session_product_status
  on public.general_inventory_validation_items(session_id, product_id, status);

create index if not exists idx_gi_snapshot_session_product
  on public.general_inventory_stock_snapshot(session_id, product_id);

create index if not exists idx_gi_observations_session_product
  on public.general_inventory_item_observations(session_id, product_id);

create index if not exists idx_gi_non_inventory_session_sku
  on public.general_inventory_non_inventory_products(session_id, sku);

create index if not exists idx_cyclic_non_inventory_active_sku
  on public.cyclic_non_inventory_products(is_active, sku);

create or replace function public.get_general_inventory_summary(p_session_id uuid)
returns table (
  product_id uuid,
  sku text,
  description text,
  unit text,
  brand text,
  department text,
  class_name text,
  subclass_name text,
  system_stock numeric,
  counted numeric,
  counted_original numeric,
  recounted_qty numeric,
  validation_qty numeric,
  diff numeric,
  cost numeric,
  value_diff numeric,
  re_counted boolean,
  recount_status text,
  validation_status text,
  validated boolean,
  observation text
)
language sql
stable
as $$
with session_flags as (
  select coalesce(validation_enabled, false) as validation_enabled
  from public.general_inventory_sessions
  where id = p_session_id
),
non_inventory as (
  select upper(trim(sku)) as sku
  from public.general_inventory_non_inventory_products
  where session_id = p_session_id
  union
  select upper(trim(sku)) as sku
  from public.cyclic_non_inventory_products
  where is_active = true
),
snapshot_base as (
  select
    s.product_id,
    s.sku,
    s.description,
    s.unit,
    coalesce(s.system_stock, 0)::numeric as system_stock,
    coalesce(s.cost, 0)::numeric as cost
  from public.general_inventory_stock_snapshot s
  where s.session_id = p_session_id
    and not exists (
      select 1 from non_inventory ni where ni.sku = upper(trim(s.sku))
    )
),
count_totals as (
  select
    c.product_id,
    max(c.sku) as sku,
    max(c.description) as description,
    max(c.unit) as unit,
    sum(coalesce(c.quantity, 0))::numeric as counted_original,
    max(coalesce(c.cost_snapshot, 0))::numeric as cost_snapshot
  from public.general_inventory_counts c
  where c.session_id = p_session_id
    and not exists (
      select 1 from non_inventory ni where ni.sku = upper(trim(c.sku))
    )
  group by c.product_id
),
base_products as (
  select product_id from snapshot_base
  union
  select product_id from count_totals
),
recount_item_times as (
  select
    ri.product_id,
    ri.id as item_id,
    max(coalesce(rc.updated_at, rc.counted_at, ri.updated_at, ri.created_at)) as latest_at
  from public.general_inventory_recount_items ri
  join public.general_inventory_recount_counts rc
    on rc.recount_item_id = ri.id
   and rc.session_id = p_session_id
  where ri.session_id = p_session_id
    and ri.status = 'counted'
    and not exists (
      select 1 from non_inventory ni where ni.sku = upper(trim(rc.sku))
    )
  group by ri.product_id, ri.id
),
latest_recount_items as (
  select distinct on (product_id)
    product_id,
    item_id
  from recount_item_times
  order by product_id, latest_at desc nulls last, item_id desc
),
recount_totals as (
  select
    ri.product_id,
    sum(coalesce(rc.quantity, 0))::numeric as recounted_qty
  from latest_recount_items lri
  join public.general_inventory_recount_items ri
    on ri.id = lri.item_id
  join public.general_inventory_recount_counts rc
    on rc.recount_item_id = ri.id
   and rc.session_id = p_session_id
  group by ri.product_id
),
assigned_recounts as (
  select distinct product_id
  from public.general_inventory_recount_items
  where session_id = p_session_id
    and status not in ('counted', 'cancelled')
),
validation_item_times as (
  select
    vi.product_id,
    vi.id as item_id,
    max(coalesce(vc.updated_at, vc.counted_at, vi.updated_at, vi.created_at)) as latest_at
  from public.general_inventory_validation_items vi
  join public.general_inventory_validation_counts vc
    on vc.validation_item_id = vi.id
   and vc.session_id = p_session_id
  where vi.session_id = p_session_id
    and vi.status = 'counted'
    and (select validation_enabled from session_flags)
    and not exists (
      select 1 from non_inventory ni where ni.sku = upper(trim(vc.sku))
    )
  group by vi.product_id, vi.id
),
latest_validation_items as (
  select distinct on (product_id)
    product_id,
    item_id
  from validation_item_times
  order by product_id, latest_at desc nulls last, item_id desc
),
validation_totals as (
  select
    vi.product_id,
    sum(coalesce(vc.quantity, 0))::numeric as validation_qty
  from latest_validation_items lvi
  join public.general_inventory_validation_items vi
    on vi.id = lvi.item_id
  join public.general_inventory_validation_counts vc
    on vc.validation_item_id = vi.id
   and vc.session_id = p_session_id
  group by vi.product_id
),
assigned_validations as (
  select distinct product_id
  from public.general_inventory_validation_items
  where session_id = p_session_id
    and status <> 'cancelled'
    and (select validation_enabled from session_flags)
),
assembled as (
  select
    bp.product_id,
    coalesce(sb.sku, ct.sku, cp.sku) as sku,
    coalesce(sb.description, ct.description, cp.description, '') as description,
    coalesce(sb.unit, ct.unit, cp.unit, '') as unit,
    cp.brand,
    cp.department,
    cp.class_name,
    cp.subclass_name,
    coalesce(sb.system_stock, 0)::numeric as system_stock,
    coalesce(vt.validation_qty, rt.recounted_qty, ct.counted_original, 0)::numeric as counted,
    coalesce(ct.counted_original, 0)::numeric as counted_original,
    rt.recounted_qty,
    vt.validation_qty,
    coalesce(sb.cost, ct.cost_snapshot, cp.cost, 0)::numeric as cost,
    case
      when rt.product_id is not null then 'counted'
      when ar.product_id is not null then 'assigned'
      else 'no'
    end as recount_status,
    case
      when vt.product_id is not null then 'counted'
      when av.product_id is not null then 'assigned'
      else 'no'
    end as validation_status,
    coalesce(obs.observation, '') as observation
  from base_products bp
  left join snapshot_base sb on sb.product_id = bp.product_id
  left join count_totals ct on ct.product_id = bp.product_id
  left join recount_totals rt on rt.product_id = bp.product_id
  left join validation_totals vt on vt.product_id = bp.product_id
  left join assigned_recounts ar on ar.product_id = bp.product_id
  left join assigned_validations av on av.product_id = bp.product_id
  left join public.general_inventory_item_observations obs
    on obs.session_id = p_session_id
   and obs.product_id = bp.product_id
  left join public.cyclic_products cp on cp.id = bp.product_id
)
select
  a.product_id,
  a.sku,
  a.description,
  a.unit,
  a.brand,
  a.department,
  a.class_name,
  a.subclass_name,
  a.system_stock,
  a.counted,
  a.counted_original,
  a.recounted_qty,
  a.validation_qty,
  (a.counted - a.system_stock)::numeric as diff,
  a.cost,
  ((a.counted - a.system_stock) * a.cost)::numeric as value_diff,
  (a.recount_status = 'counted') as re_counted,
  a.recount_status,
  a.validation_status,
  (a.validation_status = 'counted') as validated,
  a.observation
from assembled a
where a.sku is not null
  and not (a.system_stock <= 0 and a.counted <= 0)
order by abs((a.counted - a.system_stock) * a.cost) desc, a.sku;
$$;

grant execute on function public.get_general_inventory_summary(uuid) to anon, authenticated;

notify pgrst, 'reload schema';
