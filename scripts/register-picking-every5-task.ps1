$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$Root\run-picking-sync-once.cmd`""
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::MaxValue)
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 4) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName "RASECORP Picking Sync" -Action $Action -Trigger $Trigger -Settings $Settings -Description "Sincroniza requerimientos activos de picking cada 5 minutos." -Force | Out-Null
Write-Host "Tarea RASECORP Picking Sync registrada cada 5 minutos."
