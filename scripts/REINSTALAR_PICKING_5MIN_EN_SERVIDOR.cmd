@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "%~dp0register-picking-every5-task.ps1"
pause
