@echo off
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -File "%~dp0register-picking-task.ps1"
pause
