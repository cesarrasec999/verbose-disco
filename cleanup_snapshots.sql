CREATE OR REPLACE FUNCTION cleanup_old_inventory_snapshots(keep_days int DEFAULT 14)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count int;
BEGIN
  DELETE FROM inventory_valuation_snapshots
  WHERE snapshot_date < CURRENT_DATE - (keep_days || ' days')::interval;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

SELECT cron.schedule(
  'cleanup-inventory-snapshots-daily',
  '0 3 * * *',
  $cron$SELECT cleanup_old_inventory_snapshots(14);$cron$
);
