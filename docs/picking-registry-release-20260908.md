# Picking: publicacion segura de la consulta de registros

## Alcance

- Web/PWA, ruta `/picking/registros`: consulta de 50 filas por pagina con cursor
  fecha + UUID. Filtros de fecha, picador, tienda origen/destino, motivo y busqueda
  se aplican en servidor antes del limite. Cancelacion de consultas obsoletas.
- Catalogos de filtros completos e independientes de la pagina, cache de 60 s.
- Ubicacion y cantidad del escaneo original: no se convierten en stock actual ni
  se reemplazan ubicaciones historicas con etiquetas inferidas.
- Vista anterior disponible en `/picking/registros?legacy=1`, incluyendo sus
  opciones de correccion. No se retiraron funcionalidades del modulo previo.
- Dos indices concurrentes nuevos, ambos verificados validos y listos.

## Preservacion verificada en produccion

Instalacion SQL en transaccion REPEATABLE READ con huella de contenido y numero
de filas antes/despues. Una diferencia habria abortado la transaccion.

| Tabla | Filas | Resultado |
|---|---:|---|
| picking_scans | 42 430 | Contenido identico |
| picking_assignments | 59 755 | Contenido identico, incluidos avances |
| picking_request_lines | 87 039 | Contenido identico |
| picking_requests | 11 601 | Contenido identico |

Comprobacion: 2026-09-09 01:19 UTC (8 de septiembre, hora de Peru). No fue una
reconciliacion ni reparacion: no hubo UPDATE, DELETE, backfill ni reinicio del ERP.
Tampoco se alteraron los triggers o los permisos de las tablas existentes.

Validacion posterior con la API publica usada por la app: 570 registros del
5 de septiembre, 12 paginas, 570 IDs unicos; cantidades y ubicaciones coinciden
exactamente con la consulta SQL completa en el mismo orden. Mayor latencia
observada de esas lecturas secuenciales: 834 ms. NO es prueba de 50 usuarios.

## Fuera de esta publicacion

No se activan los escritores experimentales v2, ni cambios del APK, asignacion,
edicion, reasignacion, resumen/productividad, cola offline o stock por ubicacion.
No se afirma que el WMS completo ni la capacidad de 50 usuarios esten validados.
Esas partes necesitan integracion y prueba de coexistencia con clientes antiguos.

## Validacion y retorno

- TypeScript y compilacion Next.js completos.
- Prueba PostgreSQL aislada en `tests/picking-registry-read.test.cjs`:
  preservacion, 123 registros con fechas iguales, filtros y cursores sin omisiones.
- Acceso a la vista anterior inmediato mediante el enlace visible. Revertir solo
  la ruta web permite volver al componente anterior; los indices y funciones de
  lectura pueden quedarse instalados, sin tocar registros ni avances.
- No publicar archivos `.env`, credenciales, datos exportados ni el log privado.
