CREATE OR REPLACE FUNCTION public.get_audit_item_total_v2(p_session_id uuid,p_item_id uuid)
RETURNS TABLE(quantity numeric,records bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
 SELECT coalesce(sum(c.quantity),0),count(*) FROM audit_counts c WHERE c.session_id=p_session_id AND c.item_id=p_item_id;
$$;
GRANT EXECUTE ON FUNCTION public.get_audit_item_total_v2(uuid,uuid) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
