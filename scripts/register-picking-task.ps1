$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$Root\run-picking-sync.cmd`""
$Trigger = New-ScheduledTaskTrigger -AtStartup
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
Register-ScheduledTask -TaskName "RASECORP Picking Sync" -Action $Action -Trigger $Trigger -Settings $Settings -Description "Sincroniza requerimientos activos de picking cada 5 minutos." -Force | Out-Null
Write-Host "Tarea RASECORP Picking Sync registrada."
