# Diagnostico de optimizacion y seguridad de datos

Fecha: 2026-05-23

## Resumen ejecutivo

La app compila correctamente y TypeScript no reporta errores. El problema principal no parece ser una falla de build, sino una combinacion de consultas grandes desde el cliente, paginas monoliticas muy pesadas, realtime que dispara recargas completas y algunos flujos destructivos que conviene proteger mejor.

## Hallazgos criticos

1. `src/app/inventarios/page.tsx`: `deleteSession()` elimina directamente `general_inventory_sessions`. Por `on delete cascade`, esto puede borrar ubicaciones, conteos, reconteos, validaciones y snapshot de una sesion. Recomendacion: cambiar a archivado/cancelado por defecto y dejar borrado fisico solo con confirmacion doble, conteo de registros afectados y backup/export previo.

2. `src/app/dashboard/page.tsx`: existen acciones de borrado masivo en ciclicos, por ejemplo eliminar todas las asignaciones del dia y reversar cumplimiento. Tienen `confirm`, pero siguen siendo destructivas. Recomendacion: registrar auditoria de estas acciones y ofrecer "desactivar/cancelar" antes que borrar conteos reales.

3. `src/app/inventarios/page.tsx`: el flujo de actualizacion de stock puede borrar y reinsertar snapshot de una sesion cuando no se preservan OK. Ya se ajusto para preservar OK, pero conviene mover el proceso a una funcion SQL transaccional que reciba `preserve_ok_products`, para evitar cortes a mitad de batches.

## Hallazgos de rendimiento

1. `src/app/dashboard/page.tsx` tiene 8442 lineas y supera 500 KB; durante lint/build Babel avisa que desoptimiza el codigo generado. Recomendacion: dividir por modulos (`operario`, `validador`, `admin`, `resultados`, `ubicaciones`) y cargar componentes pesados con `dynamic import`.

2. `src/app/inventarios/page.tsx` tiene 7212 lineas y concentra preparacion, registros, reconteo, resumen, escaner, reportes y exportaciones. Recomendacion: separar hooks de datos y componentes por pestana para reducir renders y memoria.

3. Hay muchas consultas `select("*")` en paginas principales. Recomendacion: reemplazar por columnas necesarias, empezando por `dashboard`, `inventarios` y `auditoria`.

4. Realtime recarga vistas completas. En `dashboard`, cambios de `cyclic_counts` y `cyclic_assignments` llaman `loadOperarioData`, `loadValidadorData` o resumen completo. En `inventarios`, cambios en conteos/reconteos invalidan o recargan pestanas completas. Recomendacion: debounce unico por tabla/sesion y aplicar deltas cuando sea posible.

5. `PwaQueueSync` intenta sincronizar cada 8 segundos mientras la app esta abierta. Con 80 operarios puede generar chequeos frecuentes aunque no haya pendientes. Recomendacion: aumentar intervalo base, usar backoff, y ejecutar inmediato solo en `online`, `focus` o cuando se agrega pendiente.

6. `PwaCatalogSync` descarga catalogo offline completo diario en modo instalado. Esto es util para operarios, pero puede pesar mucho si productos/barcodes crecen. Recomendacion: activar delta real solo si `updated_at` esta mantenido por triggers o por sincronizacion ERP; si no, programar full sync fuera de hora pico.

## Hallazgos SQL

1. No conviene ejecutar `supabase_inventarios_generales.sql` completo en produccion para cambios pequenos. Mezcla creacion de tablas, indices, funcion de congelado y cambios historicos. Usar scripts minimos por feature.

2. Los `create index if not exists` sobre tablas grandes pueden bloquear/esforzar la BD si se ejecutan en hora de operacion. Recomendacion: para tablas grandes usar `create index concurrently` en scripts separados.

3. `supabase_inventarios_freeze_optimized.sql` y la funcion de congelado borran snapshot de la sesion y lo reconstruyen. Es correcto para congelado inicial, pero no para actualizaciones parciales con codigos OK. Recomendacion: mantener una funcion nueva para actualizacion incremental de no-OK.

4. `supabase_rotaciones.sql` tiene funciones que borran y recalculan agregados (`product_sales_daily`, `product_rotation_store`). Ejecutarlas por rango amplio puede consumir mucho compute. Recomendacion: correr por tienda/prefijo o en jobs programados fuera de hora pico.

5. `supabase_inventory_valuation_snapshots_dedupe.sql` elimina duplicados. Es util como mantenimiento, pero debe ejecutarse con backup o validacion previa de cantidad de filas a borrar.

## Seguridad y datos

1. Usuarios y operarios guardan `password` en tablas y se consultan desde el cliente. Esto funciona como clave operativa, pero no es seguridad fuerte. Recomendacion: al menos ocultar hashes o cambiar a flujo de autenticacion/roles si se expone fuera de red confiable.

2. `.env*` esta ignorado en git, correcto. No se detecta service role en cliente.

3. `xlsx` aparece con vulnerabilidades sin fix en `npm audit`. Recomendacion: mantenerlo solo para archivos confiables o evaluar alternativas/manejo aislado.

## Verificacion ejecutada

- `npx eslint src/app src/lib`: sin errores; 1 warning en `src/app/rotaciones/page.tsx` por dependencia faltante de hook.
- `npx tsc --noEmit --pretty false`: sin errores.
- `npm run build`: exitoso.
- `npm audit --omit=dev`: reporta vulnerabilidades en Next, ws y xlsx.

## Plan seguro recomendado

1. Proteger borrados destructivos: confirmacion doble, conteo de impacto y preferir cancelar/archivar.
2. Reducir realtime: debounce centralizado y no recargar paginas completas.
3. Reemplazar `select("*")` en rutas calientes.
4. Dividir `dashboard` e `inventarios` en componentes/hooks.
5. Mover resumen/stock pesado a funciones SQL o vistas materializadas seguras.
6. Revisar actualizacion de Next con una rama de prueba.
7. Crear scripts SQL de mantenimiento con `concurrently` y ejecucion fuera de hora pico.
