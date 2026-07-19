# Detached agent-restart helper.
#
# A ccsw "bash" job runs INSIDE CcswAgent (as a child bash.exe process) -- a
# job that tried to taskkill CcswAgent directly would kill its own executor
# mid-command, and the job would never post a result. Instead, a bash job
# spawns THIS script detached (Start-Process, hidden, no wait) and returns
# immediately. That bash job's own process then exits normally, and normally
# CcswAgent would post its own result at that point -- but it's also the
# process this script is about to kill, so if that PostResult call hasn't
# landed yet when the kill happens, the job orphans in 'running' forever.
# Instead of relying on that race, THIS script reports the triggering job's
# completion straight to the relay via curl once the new agent is confirmed
# up -- independent of whether the old process's own post made it out.
#
# CcswAgent sets CCSW_JOB_ID / CCSW_RELAY_BASE on every bash job's process
# environment (see RunBash in AgentCore.cs), so the triggering bash command
# can pass its own job id and relay base straight through as literal args --
# bash expands them before powershell.exe even starts, so no env-var lookup
# is needed on the PowerShell side.
#
# Trigger one-liner (run from a ccsw bash job on this machine):
#   powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"V:\ccswitchboard\agent\restart-agent.ps1\" -JobId $CCSW_JOB_ID -RelayBase $CCSW_RELAY_BASE'"
#
# Usage (direct, e.g. for manual testing -- omit -JobId to skip the result post):
#   powershell -File restart-agent.ps1
#   powershell -File restart-agent.ps1 -DelaySeconds 5
#   powershell -File restart-agent.ps1 -JobId 1234 -RelayBase https://dabblelabs.uk/ccswitchboard/board

param(
    [int]$DelaySeconds = 2,
    [string]$JobId = '',
    [string]$RelayBase = 'https://dabblelabs.uk/ccswitchboard/board'
)

Start-Sleep -Seconds $DelaySeconds

# No /T (tree kill): other ccsw workers may have their own bash/claude jobs
# running concurrently as children of this same CcswAgent process -- killing
# the tree would take those down too. Just the CcswAgent process itself.
taskkill /F /IM CcswAgent.exe 2>$null | Out-Null

$exePath = Join-Path $PSScriptRoot "CcswAgent\bin\Release\net10.0-windows\CcswAgent.exe"
if (-not (Test-Path $exePath)) {
    $debugExe = Join-Path $PSScriptRoot "CcswAgent\bin\Debug\net10.0-windows\CcswAgent.exe"
    if (Test-Path $debugExe) {
        $exePath = $debugExe
    } else {
        exit 1
    }
}

$workingDir = Split-Path $exePath -Parent
Start-Process -FilePath $exePath -WorkingDirectory $workingDir -WindowStyle Hidden

# Confirm the new process actually came up before reporting back -- a fresh
# process start isn't instant, and the job result should reflect what really
# happened, not just that we asked Windows to launch it.
$confirmed = $false
for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Seconds 1
    if (Get-Process -Name CcswAgent -ErrorAction SilentlyContinue) {
        $confirmed = $true
        break
    }
}

if ($JobId -ne '') {
    $resultText = if ($confirmed) { 'RESTARTED' } else { 'RESTART-FAILED: CcswAgent did not come back up' }
    $body = @{ id = [int]$JobId; result = $resultText; machine = 'vm' } | ConvertTo-Json -Compress
    curl.exe -s -X POST -H "Content-Type: application/json" -d $body "$RelayBase/result.php" | Out-Null
}
