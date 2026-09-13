-- Las filas históricas sin cantidad no provienen de un conteo finalizado.
-- Se conservan, pero dejan de presentarse como resultado de inventario general.
with unverified_locations as (
  select pl.id
  from public.product_locations pl
  where pl.last_source = 'inventario general'
    and pl.stored_quantity is null
    and pl.last_seen_at >= timestamptz '2026-09-10 00:00:00+00'
    and pl.last_seen_at < timestamptz '2026-09-11 00:00:00+00'
    and not exists (
      select 1
      from public.general_inventory_counts c
      join public.general_inventory_sessions gis on gis.id = c.session_id
      where gis.status = 'finished'
        and gis.store_id = pl.store_id
        and c.product_id = pl.product_id
        and c.location_code = pl.location
    )
)
update public.product_locations pl
   set last_source = 'ubicación sin conteo final',
       last_seen_at = pl.created_at,
       updated_at = now()
  from unverified_locations u
 where pl.id = u.id;
