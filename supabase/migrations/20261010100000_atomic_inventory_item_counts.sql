-- One transaction per recount/validation item. A receipt makes an uncertain
-- response safe to retry without replacing a later operator's work.
alter table public.general_inventory_validation_counts
  add column if not exists client_uuid text,
  add column if not exists client_device_id text,
  add column if not exists sync_origin text;
create unique index if not exists uq_gi_validation_counts_client_uuid
  on public.general_inventory_validation_counts (client_uuid)
  where client_uuid is not null;

create table if not exists public.general_inventory_item_count_receipts (
  layer text not null check (layer in ('recount','validation')),
  item_id uuid not null,
  operation_id text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (layer,item_id,operation_id)
);
alter table public.general_inventory_item_count_receipts enable row level security;
drop policy if exists inventory_item_receipts_read on public.general_inventory_item_count_receipts;
create policy inventory_item_receipts_read on public.general_inventory_item_count_receipts
  for select to anon,authenticated using (true);
drop policy if exists inventory_item_receipts_insert on public.general_inventory_item_count_receipts;
create policy inventory_item_receipts_insert on public.general_inventory_item_count_receipts
  for insert to anon,authenticated with check (true);
grant select,insert on public.general_inventory_item_count_receipts to anon,authenticated;

create or replace function public.replace_general_inventory_item_counts(
  p_layer text,
  p_item_id uuid,
  p_operation_id text,
  p_rows jsonb
) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_session_id uuid;
  v_product_id uuid;
  v_assigned_operator_id uuid;
  v_status text;
  v_previous jsonb;
  v_row record;
  v_count integer;
begin
  if p_layer not in ('recount','validation') or p_item_id is null
     or nullif(p_operation_id,'') is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Invalid inventory item count request';
  end if;
  v_count := jsonb_array_length(p_rows);
  if v_count < 1 or v_count > 50 then
    raise exception 'Inventory item requires 1 to 50 count lines';
  end if;

  if p_layer = 'recount' then
    select session_id,product_id,assigned_operator_id into v_session_id,v_product_id,v_assigned_operator_id
      from public.general_inventory_recount_items where id=p_item_id for update;
  else
    select session_id,product_id,assigned_operator_id into v_session_id,v_product_id,v_assigned_operator_id
      from public.general_inventory_validation_items where id=p_item_id for update;
  end if;
  if v_session_id is null then raise exception 'Inventory item not found'; end if;

  select payload into v_previous from public.general_inventory_item_count_receipts
    where layer=p_layer and item_id=p_item_id and operation_id=p_operation_id;
  if found then
    if v_previous <> p_rows then raise exception 'Operation ID reused with different data'; end if;
    return 'already_applied';
  end if;

  select status into v_status from public.general_inventory_sessions where id=v_session_id;
  if v_status not in ('open','frozen') then raise exception 'Inventory session is closed'; end if;

  for v_row in select * from jsonb_to_recordset(p_rows) as x(
    session_id uuid,operator_id uuid,location_id uuid,location_code text,
    product_id uuid,sku text,description text,unit text,quantity numeric,
    cost_snapshot numeric,counted_at timestamptz,updated_at timestamptz,
    client_uuid text,client_device_id text,sync_origin text)
  loop
    if v_row.session_id is distinct from v_session_id or v_row.product_id is distinct from v_product_id
       or v_row.operator_id is null
       or (v_assigned_operator_id is not null and v_row.operator_id is distinct from v_assigned_operator_id)
       or v_row.quantity is null or v_row.quantity < 0 then
      raise exception 'Inventory count line does not match assigned item';
    end if;
    if v_row.location_id is not null and not exists (
      select 1 from public.general_inventory_locations
      where id=v_row.location_id and session_id=v_session_id
    ) then raise exception 'Inventory count location is outside the session'; end if;
  end loop;

  if p_layer = 'recount' then
    delete from public.general_inventory_recount_counts where recount_item_id=p_item_id;
    insert into public.general_inventory_recount_counts (
      recount_item_id,session_id,operator_id,location_id,location_code,product_id,
      sku,description,unit,quantity,cost_snapshot,counted_at,updated_at,
      client_uuid,client_device_id,sync_origin)
    select p_item_id,r.session_id,r.operator_id,r.location_id,r.location_code,r.product_id,
      r.sku,r.description,r.unit,r.quantity,coalesce(r.cost_snapshot,0),
      coalesce(r.counted_at,now()),coalesce(r.updated_at,now()),
      r.client_uuid,r.client_device_id,r.sync_origin
    from jsonb_to_recordset(p_rows) as r(
      session_id uuid,operator_id uuid,location_id uuid,location_code text,
      product_id uuid,sku text,description text,unit text,quantity numeric,
      cost_snapshot numeric,counted_at timestamptz,updated_at timestamptz,
      client_uuid text,client_device_id text,sync_origin text);
    update public.general_inventory_recount_items set status='counted',updated_at=now() where id=p_item_id;
  else
    delete from public.general_inventory_validation_counts where validation_item_id=p_item_id;
    insert into public.general_inventory_validation_counts (
      validation_item_id,session_id,operator_id,location_id,location_code,product_id,
      sku,description,unit,quantity,cost_snapshot,counted_at,updated_at,
      client_uuid,client_device_id,sync_origin)
    select p_item_id,r.session_id,r.operator_id,r.location_id,r.location_code,r.product_id,
      r.sku,r.description,r.unit,r.quantity,coalesce(r.cost_snapshot,0),
      coalesce(r.counted_at,now()),coalesce(r.updated_at,now()),
      r.client_uuid,r.client_device_id,r.sync_origin
    from jsonb_to_recordset(p_rows) as r(
      session_id uuid,operator_id uuid,location_id uuid,location_code text,
      product_id uuid,sku text,description text,unit text,quantity numeric,
      cost_snapshot numeric,counted_at timestamptz,updated_at timestamptz,
      client_uuid text,client_device_id text,sync_origin text);
    update public.general_inventory_validation_items set status='counted',updated_at=now() where id=p_item_id;
  end if;
  insert into public.general_inventory_item_count_receipts(layer,item_id,operation_id,payload)
    values(p_layer,p_item_id,p_operation_id,p_rows);
  return 'applied';
end $$;
revoke all on function public.replace_general_inventory_item_counts(text,uuid,text,jsonb) from public;
grant execute on function public.replace_general_inventory_item_counts(text,uuid,text,jsonb) to anon,authenticated;
