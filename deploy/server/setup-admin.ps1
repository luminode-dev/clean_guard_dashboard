# 관리자 권한 필요: FastAPI 부팅 시 자동 실행 작업 (127.0.0.1 바인딩이라 방화벽 규칙 불필요)
$ErrorActionPreference='Stop'
$action=New-ScheduledTaskAction -Execute 'C:\server\app\run-app.cmd' -WorkingDirectory 'C:\server\app'
$trigger=New-ScheduledTaskTrigger -AtStartup
$settings=New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Unregister-ScheduledTask -TaskName 'CleanGuardAPI' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName 'CleanGuardAPI' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Clean Guard ingest & dashboard API (FastAPI :8010)' | Out-Null
Start-ScheduledTask -TaskName 'CleanGuardAPI'
"OK" | Out-File -Encoding utf8 C:\server\app\setup-admin.done
