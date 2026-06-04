@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "%~dp0register-ventas-diario-task.ps1"
pause
