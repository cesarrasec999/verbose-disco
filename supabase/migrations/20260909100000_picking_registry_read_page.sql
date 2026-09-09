-- Read-only release: leaves all assignment/scan writers and historic rows intact.
create or replace function public.get_picking_registry_page_v2(
  p_from date default null,p_to date default null,p_source text default null,
  p_destination text default null,p_picker text default null,p_reason text default null,
  p_query text default null,p_before_at timestamptz default null,
  p_before_id uuid default null,p_limit int default 50
) returns table(scan jsonb,request jsonb,line jsonb,picker_name text)
language sql stable security invoker set search_path=public
set statement_timeout='10s' set plan_cache_mode='force_custom_plan' as $$
  select to_jsonb(s),to_jsonb(r),to_jsonb(l),coalesce(u.full_name,s.picker_name,'Sin nombre registrado')
  from picking_scans s
  join picking_requests r on r.id=s.request_id
  join picking_request_lines l on l.id=s.line_id
  left join cyclic_users u on u.id=s.picker_id
  where r.hidden_at is null
    and (p_from is null or s.created_at>=p_from::timestamp at time zone 'UTC')
    and (p_to is null or s.created_at<(p_to+1)::timestamp at time zone 'UTC')
    and (p_source is null or r.source_store_code=p_source)
    and (p_destination is null or r.destination_store_code=p_destination)
    and (p_picker is null or s.picker_id=case when p_picker ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_picker::uuid end
      or (s.picker_id is null and s.picker_name=p_picker))
    and (p_reason is null or r.reason=p_reason)
    and (nullif(btrim(p_query),'') is null or l.product_code ilike '%'||p_query||'%'
      or l.description ilike '%'||p_query||'%' or s.location_code ilike '%'||p_query||'%'
      or l.barcode=p_query or r.doc_number ilike '%'||p_query||'%'
      or r.inv_request_no ilike '%'||p_query||'%')
    and (p_before_at is null or (s.created_at,s.id)<(p_before_at,p_before_id))
  order by s.created_at desc,s.id desc limit least(greatest(coalesce(p_limit,50),1),51);
$$;

create or replace function public.get_picking_registry_filters_v2()
returns jsonb language sql stable security invoker set search_path=public
set statement_timeout='10s' as $$
  select jsonb_build_object(
    'sources',(select coalesce(jsonb_agg(x order by x.label),'[]'::jsonb) from (
      select source_store_code as key,max(coalesce(nullif(source_store_name,''),source_store_code)) as label
      from picking_requests where hidden_at is null group by source_store_code) x),
    'destinations',(select coalesce(jsonb_agg(x order by x.label),'[]'::jsonb) from (
      select destination_store_code as key,max(coalesce(nullif(destination_store_name,''),destination_store_code)) as label
      from picking_requests where hidden_at is null group by destination_store_code) x),
    'reasons',(select coalesce(jsonb_agg(x order by x.label),'[]'::jsonb) from (
      select distinct reason as key,reason as label from picking_requests
      where hidden_at is null and nullif(reason,'') is not null) x),
    'pickers',(select coalesce(jsonb_agg(x order by x.label),'[]'::jsonb) from (
      select distinct coalesce(s.picker_id::text,s.picker_name) as key,
        coalesce(u.full_name,s.picker_name,'Sin nombre registrado') as label
      from picking_scans s left join cyclic_users u on u.id=s.picker_id
      where coalesce(s.picker_id::text,s.picker_name) is not null) x)
  );
$$;
grant execute on function public.get_picking_registry_page_v2(date,date,text,text,text,text,text,timestamptz,uuid,int),
  public.get_picking_registry_filters_v2() to anon,authenticated,service_role;
notify pgrst,'reload schema';
