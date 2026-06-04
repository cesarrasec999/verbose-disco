@echo off
cd /d "%~dp0"
node sync-reportes-ventas.js --yesterday
