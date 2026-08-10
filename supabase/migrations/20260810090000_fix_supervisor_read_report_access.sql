-- Completa los permisos de consulta de supervisores.
-- No habilita usuarios, administracion ni acciones de captura; solo reportes
-- y analisis de lectura para todas las tiendas.
update public.cyclic_users
set
  module_access = (
    select jsonb_agg(to_jsonb(key) order by key)
    from (
      select distinct key
      from (
        select key
        from jsonb_array_elements_text(coalesce(module_access, '[]'::jsonb)) as existing(key)
        where key in (
          'cyclic_count_records', 'cyclic_summary_by_code', 'cyclic_store_progress',
          'cyclic_dashboard', 'reports_non_inventory', 'reports_results', 'reports',
          'analysis', 'locations', 'audit', 'general_inventory', 'consulta',
          'picking', 'packing', 'ajustes_provisionales', 'checklist'
        )
        union all
        select key
        from (values
          ('cyclic_count_records'), ('cyclic_summary_by_code'), ('cyclic_store_progress'),
          ('cyclic_dashboard'), ('reports_non_inventory'), ('reports_results'), ('reports'),
          ('analysis'), ('general_inventory'), ('consulta')
        ) defaults(key)
      ) merged_keys
    ) merged
  ),
  can_access_all_stores = true,
  updated_at = now()
where role = 'Supervisor';
