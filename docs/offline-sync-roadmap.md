# Base para app offline y tiempo real

Este documento deja ordenada la direccion tecnica sin cambiar la funcionalidad actual de la web.

## Objetivo

- Mantener una sola web para laptop y celular.
- Convertirla luego en PWA instalable en Android y iPhone.
- Permitir conteos sin internet guardando en el celular.
- Sincronizar automaticamente cuando vuelva la conexion.
- Evitar duplicados si el usuario presiona guardar varias veces o si se reintenta la sincronizacion.

## Piezas agregadas

- `supabase_offline_sync_foundation.sql`: agrega `client_uuid`, `client_device_id` y `sync_origin` a las tablas de conteo. Son columnas opcionales, por eso la web actual sigue funcionando igual.
- `src/lib/offline/types.ts`: tipos comunes para la cola local offline.
- `src/lib/offline/clientIdentity.ts`: genera un id del dispositivo y ids unicos por operacion.
- `src/lib/offline/pendingQueue.ts`: cola local en IndexedDB para guardar operaciones pendientes.
- `src/lib/realtime/channels.ts`: nombres estables para futuros canales realtime por modulo.
- `public/manifest.webmanifest`: permite instalar la web como app.
- `public/sw.js`: service worker base para cache de la app y pantalla sin conexion.
- `public/offline.html`: pantalla simple cuando no hay conexion.
- `src/app/PwaRegister.tsx`: registra el service worker en navegadores compatibles.
- `src/app/PwaCatalogSync.tsx`: en la app instalada descarga tiendas, productos, codigos de barra y stock a IndexedDB.
- `src/app/PwaQueueSync.tsx`: sincroniza conteos pendientes cuando vuelve internet.

## Conectado a la web actual

Los nuevos registros online ya guardan `client_uuid`, `client_device_id` y `sync_origin = 'web'` en:

- Conteos y reconteos ciclicos.
- Conteos de auditoria.
- Conteos y reconteos de inventario general.
- Inventario general escucha cambios de reconteo en tiempo real para que el operario vea asignaciones nuevas sin refrescar.
- Inventario general puede guardar conteos sin conexion en cola local y subirlos cuando vuelva internet.

## Flujo futuro

1. El usuario guarda un conteo.
2. Si hay internet, se envia a Supabase con `client_uuid`.
3. Si no hay internet, se guarda en IndexedDB.
4. Al volver la conexion, la cola envia pendientes.
5. Supabase rechaza duplicados por `client_uuid` si se reintenta la misma operacion.
6. Las pantallas escuchan cambios por realtime y refrescan solo lo necesario.

## Tablas preparadas

- `cyclic_counts`
- `audit_counts`
- `general_inventory_counts`
- `general_inventory_recount_counts`

## Importante

La instalacion PWA, el cache de catalogo, el realtime de reconteos y la cola offline inicial para conteos de inventario general ya estan conectados. La cola offline para ciclicos, auditorias y reconteos se hara por modulo para no romper reglas actuales.
