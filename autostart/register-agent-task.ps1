# Registers a Task Scheduler task that starts CcswAgent hidden at logon.
#
# Run this ON THE VM, logged in as the account that will run CcswAgent -- the
# agent polls the relay and launches claude.exe locally, so it must run
# where Claude Code and the target repos actually live.
#
# CcswAgent is now a WinExe tray app with no console of its own, but the
# action below still launches it through a hidden PowerShell wrapper (a
# leftover from when it was a plain console app) -- harmless, since hiding an
# already-windowless app is a no-op, and not worth touching working Task
# Scheduler logic just to remove it.
#
# Usage:
#   powershell -File register-agent-task.ps1
#   powershell -File register-agent-task.ps1 -ExePath "C:\path\to\CcswAgent.exe"

param(
    [string]$ExePath = (Join-Path $PSScriptRoot "..\agent\CcswAgent\bin\Release\net10.0-windows\CcswAgent.exe")
)

$TaskName = "CcswAgent"

if (-not (Test-Path $ExePath)) {
    $debugExe = Join-Path $PSScriptRoot "..\agent\CcswAgent\bin\Debug\net10.0-windows\CcswAgent.exe"
    if (Test-Path $debugExe) {
        $ExePath = $debugExe
    } else {
        Write-Error "CcswAgent.exe not found at '$ExePath' or the Debug equivalent. Build it first: dotnet build (or dotnet build -c Release) in agent/CcswAgent."
        exit 1
    }
}

$ExePath = (Resolve-Path $ExePath).Path
$WorkingDir = Split-Path $ExePath -Parent

if (-not (Test-Path (Join-Path $WorkingDir "agent.config.json"))) {
    Write-Warning "agent.config.json not found next to $ExePath -- CcswAgent will fail to start until it's copied from agent.config.example.json and filled in."
}

$wrapperCommand = "Start-Process -FilePath '$ExePath' -WorkingDirectory '$WorkingDir' -WindowStyle Hidden"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -Command `"$wrapperCommand`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# StartWhenAvailable: if the logon trigger is missed (e.g. this task is
# updated/re-registered mid-session, or the scheduler was briefly
# unavailable at logon), run it as soon as possible afterwards instead of
# waiting for the next logon.
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "Starts the CcswAgent background poller hidden at logon (ccswitchboard)." -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' -> $ExePath"
Write-Host "Start it immediately without waiting for the next logon: Start-ScheduledTask -TaskName '$TaskName'"
