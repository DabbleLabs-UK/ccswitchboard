# Registers a Task Scheduler task that starts CcswPopup at logon.
#
# Run this ON THE HOST machine, logged in as the account that uses Brave --
# CcswPopup raises Brave's window via SetForegroundWindow, so it must run on
# the physical desktop where Brave actually is, not the VM.
#
# CcswPopup is a WinExe (WPF) app with no console window of its own, so
# unlike the agent's task it's launched directly -- nothing to hide.
#
# Usage:
#   powershell -File register-popup-task.ps1
#   powershell -File register-popup-task.ps1 -ExePath "C:\path\to\CcswPopup.exe"

param(
    [string]$ExePath = (Join-Path $PSScriptRoot "..\popup\CcswPopup\bin\Release\net10.0-windows\CcswPopup.exe")
)

$TaskName = "CcswPopup"

if (-not (Test-Path $ExePath)) {
    $debugExe = Join-Path $PSScriptRoot "..\popup\CcswPopup\bin\Debug\net10.0-windows\CcswPopup.exe"
    if (Test-Path $debugExe) {
        $ExePath = $debugExe
    } else {
        Write-Error "CcswPopup.exe not found at '$ExePath' or the Debug equivalent. Build it first: dotnet build (or dotnet build -c Release) in popup/CcswPopup."
        exit 1
    }
}

$ExePath = (Resolve-Path $ExePath).Path
$WorkingDir = Split-Path $ExePath -Parent

if (-not (Test-Path (Join-Path $WorkingDir "popup.config.json"))) {
    Write-Warning "popup.config.json not found next to $ExePath -- CcswPopup will fail to start until it's copied from popup.config.example.json and filled in."
}

$action = New-ScheduledTaskAction -Execute $ExePath -WorkingDirectory $WorkingDir

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
    -Description "Starts the CcswPopup notifier at logon (ccswitchboard)." -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' -> $ExePath"
Write-Host "Start it immediately without waiting for the next logon: Start-ScheduledTask -TaskName '$TaskName'"
