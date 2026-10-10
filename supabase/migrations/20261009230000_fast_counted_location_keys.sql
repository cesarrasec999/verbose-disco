-- The preparation screen needs unique counted location keys, not every count row.
-- Include keys resolved through location_id for older counts with an empty code.
create or replace function public.get_general_inventory_counted_location_codes(p_session_id uuid)
returns table(location_code text)
language sql
stable
security invoker
set search_path = public
as $$
  select distinct btrim(v.code)::text as location_code
  from public.general_inventory_counts c
  left join public.general_inventory_locations l
    on l.id = c.location_id
   and l.session_id = c.session_id
   and l.is_active is distinct from false
  cross join lateral (values (c.location_code), (l.location_code), (l.ticket)) v(code)
  where c.session_id = p_session_id
    and nullif(btrim(v.code), '') is not null;
$$;

revoke all on function public.get_general_inventory_counted_location_codes(uuid) from public;
grant execute on function public.get_general_inventory_counted_location_codes(uuid) to anon, authenticated, service_role;

notify pgrst, 'reload schema';
