# Recepcion: sincronizacion con Google Sheets

El modulo de recepcion envia automaticamente las diferencias al completar un requerimiento.

## Variables requeridas

Agregar en `.env.local`:

```env
RECEPTION_DIFFERENCES_SPREADSHEET_ID=1HcIfilt-WV7QpAVcd345ffXfoYQ7kret
GOOGLE_SHEETS_CLIENT_EMAIL=cuenta-servicio@proyecto.iam.gserviceaccount.com
GOOGLE_SHEETS_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

## Permisos en Google Sheets

Compartir el archivo de Google Sheets con el correo de `GOOGLE_SHEETS_CLIENT_EMAIL` y darle permiso de editor.

## Comportamiento

- Al completar una recepcion, se agregan solo las lineas con diferencia.
- La pestana destino usa el nombre real de la tienda.
- Si una pestana existente coincide claramente con el codigo o una abreviatura de la tienda, se renombra al nombre real.
- Se evita duplicar una misma linea usando una clave de sincronizacion en la columna `Sync key`.
