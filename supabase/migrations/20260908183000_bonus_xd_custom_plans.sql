-- Partition/date/store selectivity differs substantially by cutoff.
-- A generic cached plan can scan the complete monthly partition.
ALTER FUNCTION public.get_bonus_xd_value_v2(date,date,jsonb) SET plan_cache_mode = force_custom_plan;
NOTIFY pgrst,'reload schema';
