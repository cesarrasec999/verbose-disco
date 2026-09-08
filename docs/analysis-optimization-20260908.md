# Auditoría y Análisis: optimización del 8 de septiembre de 2026

## Cambios

- Registros de auditoría: lectura real de 50 filas por página, orden estable fecha/ID, búsqueda aplicada antes del límite y totales independientes calculados en PostgreSQL.
- Resumen: renderiza 50 códigos por página. Las asignaciones necesarias para contar y exportar se siguen leyendo completas en lotes de 500; no se confunden con las 50 filas de registros.
- Realtime limitado a la sesión abierta; no se refrescan todas las sesiones por cada conteo. Pausa de lecturas automáticas con la pestaña oculta.
- Reintento de guardado conserva la identidad de la operación mientras el formulario está abierto. Una respuesta perdida se confirma consultando esa identidad; un nuevo conteo confirmado recibe otra identidad. No se convierte el registro en un upsert por producto.
- Cobertura: intersección real entre códigos con stock positivo y productos muestreados. Lecturas con concurrencia acotada; caché en memoria de 60 segundos por usuario, con actualización manual.
- Bono: agregados mensuales compactos; auditorías trimestrales mediante resumen SQL. X+D compara el mismo conjunto de códigos de la última rotación disponible en ambos cortes, sin unir categorías de todos los meses.
- X+D: fechas reales de valorizado y rotación identificadas. Lecturas por tienda con índices existentes y agregación de la hora de cierre calculada una sola vez. Se evita el plan de ejecución que recalculaba el máximo por cada fila.
- Excel mensual: detalle bajo demanda, conciliado contra el resumen antes de descargar; período y fuentes identificados. No se etiqueta un resultado viejo con el mes recién seleccionado.
- APK: páginas de registros y resumen, totales completos, protección contra doble toque/reintento y Guardar responde con teclado abierto. No hay dependencias nativas nuevas.

## Validación realizada contra producción (solo lectura)

- 957 registros de una sesión recorridos en 20 páginas: mismos IDs y orden que la consulta original, sin omisiones ni duplicados.
- Totales de todas las sesiones reconciliados con la suma de sus registros: cero diferencias.
- 13.337 conteos anteriores al 08/09 UTC y 18.245 asignaciones de auditorías finalizadas: número de filas y huella del contenido idénticos antes/después. Los conteos nuevos del día se excluyeron del control inmutable para permitir la operación normal.
- Ventas agregadas julio/agosto coinciden con las ventas diarias guardadas. Esto no afirma que el reporte externo RMS esté íntegramente conciliado.
- X+D: 24 tiendas en junio/julio/agosto; 3,59 / 2,76 / 2,95 segundos para cada corte, con dos consultas simultáneas como máximo. Tiempos observados, no SLA.
- 50 lecturas de páginas con máximo 3 simultáneas: mediana 230 ms, percentil 95 de 395 ms, máximo 436 ms. No equivale a probar 50 usuarios escribiendo a la vez.
- Cobertura/Excel de Perla reconciliados: 4.287 códigos con stock positivo, 1.155 muestreados en el momento de la prueba. El stock sigue cambiando normalmente.
- Cuatro pruebas automatizadas: límites de concurrencia/orden, caché y recuperación de errores, códigos ERP y rechazo de alias ambiguos.
- Compilación web y TypeScript correctos. TypeScript y empaquetado Android correctos. No se realizaron conteos de prueba en producción ni pruebas físicas en teléfonos.

## Límites y recuperación

- Las recepciones usan el estado RMS disponible al consultar, no un estado histórico reconstruido al cierre. La pantalla lo advierte. Un cierre inmutable de bono requiere conservar fuentes históricas por período; no se inventó ese historial.
- Los resultados de Bono no se guardan como un cierre contable definitivo. Las fechas y fuentes quedan en la exportación.
- Las migraciones son aditivas y de lectura: no borran ni reescriben inventarios, conteos, reconteos o movimientos. Ante reversión de interfaz, conservar las funciones nuevas para no interrumpir versiones APK ya distribuidas.
- Versión web anterior: `3a70e4e`. Grupo OTA Android anterior: `3d820eae-ea13-4f95-ba2e-87fbb7f7c3ad` (runtime `1.0.0`).
