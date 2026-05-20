# Rotaciones mensuales

Coloca aqui el Excel mensual de rotaciones antes de importarlo.

Formato esperado:

- Columna A: `CODIGO`
- Columna B: `Descripcion`
- Columna C: `Pres.`
- Desde la columna D: una columna por tienda, con la rotacion del producto en esa tienda.

Ejemplo de comando:

```powershell
cd "C:\Users\Manuel Coaquera\ciclicos"
node scripts\import-rotaciones-mensuales.js ".\imports\rotaciones\ROT TIENDA MAY.xlsx" 2026-05
```
