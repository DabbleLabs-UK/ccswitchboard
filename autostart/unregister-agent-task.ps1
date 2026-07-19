# Removes the "CcswAgent" Task Scheduler task created by register-agent-task.ps1.
#
# Run this ON THE VM. Safe to run even if the task was never registered.
#
# Usage:
#   powershell -File unregister-agent-task.ps1

$TaskName = "CcswAgent"

if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) {
    Write-Host "Task '$TaskName' is not registered -- nothing to do."
    exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Unregistered scheduled task '$TaskName'."
