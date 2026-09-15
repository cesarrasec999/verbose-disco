-- Seguridad, fase 6: estas tablas son calculadas/sincronizadas por el servidor
-- .53 con service_role. Los clientes PWA/APK/web únicamente las consultan.

begin;

set local lock_timeout = '1s';
set local statement_timeout = '15s';

drop policy if exists business_holidays_write on public.business_holidays;
create policy business_holidays_select on public.business_holidays
  for select to anon, authenticated using (true);

drop policy if exists "erp product sales daily write" on public.erp_product_sales_daily;
create policy "erp product sales daily read" on public.erp_product_sales_daily
  for select to anon, authenticated using (true);

drop policy if exists erp_store_sales_daily_write on public.erp_store_sales_daily;
create policy erp_store_sales_daily_select on public.erp_store_sales_daily
  for select to anon, authenticated using (true);

drop policy if exists "inventory rotation valuation daily write" on public.inventory_rotation_valuation_daily;
create policy "inventory rotation valuation daily read" on public.inventory_rotation_valuation_daily
  for select to anon, authenticated using (true);

drop policy if exists "inventory valuation snapshot stores write" on public.inventory_valuation_snapshot_stores;
create policy "inventory valuation snapshot stores read" on public.inventory_valuation_snapshot_stores
  for select to anon, authenticated using (true);

drop policy if exists "inventory valuation snapshots write" on public.inventory_valuation_snapshots;
create policy "inventory valuation snapshots read" on public.inventory_valuation_snapshots
  for select to anon, authenticated using (true);

drop policy if exists product_rotation_monthly_write on public.product_rotation_monthly;
create policy product_rotation_monthly_select on public.product_rotation_monthly
  for select to anon, authenticated using (true);

revoke insert, update, delete, truncate, references, trigger
  on table
    public.business_holidays,
    public.erp_product_sales_daily,
    public.erp_store_sales_daily,
    public.inventory_rotation_valuation_daily,
    public.inventory_valuation_snapshot_stores,
    public.inventory_valuation_snapshots,
    public.product_rotation_monthly
  from anon, authenticated;

grant select
  on table
    public.business_holidays,
    public.erp_product_sales_daily,
    public.erp_store_sales_daily,
    public.inventory_rotation_valuation_daily,
    public.inventory_valuation_snapshot_stores,
    public.inventory_valuation_snapshots,
    public.product_rotation_monthly
  to anon, authenticated;

notify pgrst, 'reload schema';

commit;
