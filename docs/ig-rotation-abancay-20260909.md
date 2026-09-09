# Reporte IG: resolución de sede para rotaciones

Corrección del 9/9/2026, limitada a la lectura del resumen y Reporte IG.

La función de consulta normalizaba el nombre de sede quitando signos. Esto descartaba la clave exacta `GPC025 APU - ABANCAY` y únicamente encontraba el alias antiguo `ABANCAY`: seleccionaba mayo en lugar de agosto para la sesión programada el 4/9/2026. Se conserva ahora el nombre original en mayúsculas, además de los aliases compatibles, y se contempla `store_erp_sede` de la sesión si no está cargado el directorio de tiendas. Se mantiene la selección de un único período anterior al mes programado.

## Validación

- Seis pruebas de regresión: nombre completo, sede incluida en sesión, alias histórico, aislamiento entre tiendas/períodos, lotes de 500 para 2.323 códigos y ausencia de período.
- Consulta real con cliente público: los 2.323 códigos de la sesión `964a9010-de5e-4ced-b6de-c3c3a9a1ca23` coinciden con agosto: A 12, B 77, C 192, D 952, X 1.073 y Sin rotación 17.
- De los 17, uno está clasificado explícitamente Sin rotación y 16 no tienen fila en agosto. No se heredan categorías de mayo para rellenarlos.

No se ejecutan migraciones ni escrituras sobre tablas de inventario o rotación. No se modifican stock, conteos, reconteos, validaciones, observaciones ni cierres. La corrección es general para las sedes que utilizan nombres completos; no renombra claves ni recalcula clasificaciones históricas.

Después del despliegue se debe recargar la página y generar otra vez Reporte IG. Los documentos descargados antes de la corrección no cambian automáticamente.
