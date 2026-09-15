# Endurecimiento de Supabase — 15/09/2026

## Principios de aplicación

- No borrar, reescribir ni reconstruir datos durante el endurecimiento.
- Usar `lock_timeout` corto para abandonar antes de bloquear a usuarios activos.
- Aplicar primero objetos no operativos y permisos internos.
- Validar PWA, APK y web antes de continuar con tablas operativas.
- No eliminar índices marcados como “unused” sin métricas de uso y un periodo de observación.

## Fase 1

Migración: `20260915100000_security_hardening_phase1.sql`.

- Protege cinco tablas de respaldo sin cambiar sus filas.
- Protege `audit_session_item_removal_log`; la RPC atómica conserva la escritura.
- Protege contra escritura directa `product_location_history` y conserva su lectura.
- Convierte dos vistas de abastecimiento a `security_invoker`.
- Fija `search_path` en las funciones indicadas por el Advisor.
- Revoca ejecución a clientes sólo en funciones internas de trigger/mantenimiento.

## Validación obligatoria

1. Comparar estimaciones de filas y tamaño físico de las siete tablas antes/después, sin ejecutar escaneos completos en horario operativo.
2. Probar login y cambio de contraseña.
3. Probar lectura y exportación del historial de ubicaciones.
4. Probar retiro de un producto sin conteos en una sesión de auditoría de prueba.
5. Confirmar que inventarios abiertos siguen guardando y que finalizar encola la sincronización.
6. Confirmar lectura de las vistas de abastecimiento.
7. Volver a ejecutar Security Advisor.

## Fases siguientes

- Reemplazar políticas de escritura `true` por permisos basados en usuario, tienda y rol.
- Proteger las tres particiones activas de septiembre en una ventana de baja carga.
- La migración `20260915103000_consolidate_equivalent_rls_policies.sql`
  elimina 19 políticas SELECT redundantes sin cambiar permisos efectivos.
- La migración `20260915110000_protect_inactive_internal_partitions.sql`
  protege las particiones internas históricas y futuras; septiembre de 2026 se
  deja para una ventana de baja carga.
- Revisar índices duplicados y crear índices faltantes con operaciones concurrentes en horario de baja carga.
