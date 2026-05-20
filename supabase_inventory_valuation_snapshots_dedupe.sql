-- Limpia fotografias duplicadas de valorizado y evita que vuelvan a duplicarse.
-- Conserva la fotografia mas reciente por snapshot_date + snapshot_time.

with ranked as (
  select
    id,
    row_number() over (
      partition by snapshot_date, snapshot_time
      order by created_at desc, updated_at desc, id desc
    ) as rn
  from public.inventory_valuation_snapshots
)
delete from public.inventory_valuation_snapshots s
using ranked r
where s.id = r.id
  and r.rn > 1;

create unique index if not exists uq_inventory_valuation_snapshots_date_time
  on public.inventory_valuation_snapshots(snapshot_date, snapshot_time);
