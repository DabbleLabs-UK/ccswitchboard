# Removes the "CcswPopup" Task Scheduler task created by register-popup-task.ps1.
#
# Run this ON THE HOST. Safe to run even if the task was never registered.
#
# Usage:
#   powershell -File unregister-popup-task.ps1

$TaskName = "CcswPopup"

if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Host "Task '$TaskName' is not registered -- nothing to do."
    exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Unregistered scheduled task '$TaskName'."
