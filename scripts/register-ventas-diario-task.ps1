$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$Root\run-ventas-sync-diario.cmd`""
$Trigger = New-ScheduledTaskTrigger -Daily -At "00:01"
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName "RASECORP Ventas Sync Diario" -Action $Action -Trigger $Trigger -Settings $Settings -Description "Sincroniza ventas del dia anterior a las 12:01 AM." -Force | Out-Null
Write-Host "Tarea RASECORP Ventas Sync Diario registrada (12:01 AM diario)."
