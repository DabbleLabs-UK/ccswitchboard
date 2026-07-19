# ccswitchboard autostart

Registers the two long-running ccswitchboard processes as Task Scheduler
tasks that start at logon, so neither needs a terminal window left open.

Both `CcswAgent` and `CcswPopup` are now system-tray apps -- each has a
"Register at startup" / "Unregister from startup" item on its own tray menu
that calls the matching script below directly, so running these scripts by
hand is only needed for first-time setup or troubleshooting.

| Script | Run on | What it starts |
|---|---|---|
| `register-agent-task.ps1` | the VM | `agent/CcswAgent` -- polls the relay and launches `claude.exe` locally |
| `unregister-agent-task.ps1` | the VM | removes the `CcswAgent` task |
| `register-popup-task.ps1` | the host | `popup/CcswPopup` -- polls the relay and pops up job-completion notices, raising Brave on the physical desktop |
| `unregister-popup-task.ps1` | the host | removes the `CcswPopup` task |

Each register script is idempotent (`Register-ScheduledTask -Force`) -- re-run
it after rebuilding to pick up a new exe path, or to refresh the task's
settings. The unregister scripts are no-ops if the task isn't registered.

## One-time setup

1. Build the app first (`dotnet build` or `dotnet build -c Release` in the
   respective project folder). Both scripts default to the `Release` output
   path and fall back to `Debug` if `Release` doesn't exist.
2. Make sure `agent.config.json` / `popup.config.json` exist next to the
   built exe (copy from the matching `*.config.example.json` and fill in
   values -- see each project's own README/comments). Both scripts warn if
   the config file is missing.
3. Run the matching script in a normal PowerShell window, logged in as the
   account that will actually be logged in when you want the app running:

       powershell -File register-agent-task.ps1     # on the VM
       powershell -File register-popup-task.ps1      # on the host

   Registering a per-user logon task doesn't require an elevated prompt in
   the normal case; if your account lacks rights to create scheduled tasks,
   run PowerShell as Administrator once instead.
4. Start it immediately without logging off/on:

       Start-ScheduledTask -TaskName CcswAgent    # on the VM
       Start-ScheduledTask -TaskName CcswPopup    # on the host

## Design notes

- **Trigger**: "At log on" for the current user, plus `StartWhenAvailable`
  so a missed trigger (e.g. the scheduler was briefly unavailable right at
  logon, or the task was just re-registered mid-session) still runs as soon
  as possible instead of waiting for the next logon.
- **No visible windows**: both apps are WinExe tray apps (no console
  subsystem), so neither shows a window when Task Scheduler starts them.
  `register-agent-task.ps1` still launches `CcswAgent` through a hidden
  PowerShell wrapper (`Start-Process -WindowStyle Hidden`) from when it was a
  console app -- harmless now (hiding a window that's already hidden), kept
  to avoid touching working Task Scheduler logic unnecessarily. Agent/popup
  diagnostic output isn't lost by having no console -- it was never written
  to a file either way; check `feed.php`/the relay for job-level output
  instead.
- **Restart on failure**: both tasks retry up to 3 times, 1 minute apart, if
  the process exits unexpectedly.
- **No execution time limit**: both processes run in an infinite poll loop
  by design, so `ExecutionTimeLimit` is set to zero (no Task Scheduler
  timeout kill).

## Removing a task

    powershell -File unregister-agent-task.ps1   # on the VM
    powershell -File unregister-popup-task.ps1   # on the host

(or use each app's own tray menu -- "Unregister from startup")

## Restarting CcswAgent from a ccsw job

`CcswAgent` runs ccsw "bash" jobs as its own child processes, so a job that
tried `taskkill CcswAgent.exe` directly would kill its own executor before
it could report back. `../agent/restart-agent.ps1` works around this: spawn
it **detached** so it outlives the triggering job, and it waits out that
job's own completion before killing and relaunching the agent.

Trigger it with a ccsw bash job whose command is:

    powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \"V:\ccswitchboard\agent\restart-agent.ps1\" -JobId $CCSW_JOB_ID -RelayBase $CCSW_RELAY_BASE'"

The job's own `bash.exe`/`powershell.exe` process returns immediately (the
outer `Start-Process` call doesn't wait), so the job completes. ~2 seconds
later, the detached script kills any running `CcswAgent.exe` (by image name
only, no process tree, so it doesn't take down other jobs' bash/claude
children) and relaunches it from
`agent/CcswAgent/bin/Release/net10.0-windows/` (falling back to `Debug/` if
Release isn't built).

Killing `CcswAgent` this way also kills the process that would otherwise
post this job's own result, so the triggering job would orphan in
'running' forever if we relied on that race. Instead, `CcswAgent` exports
`CCSW_JOB_ID`/`CCSW_RELAY_BASE` into every bash job's process environment
(see `RunBash` in `AgentCore.cs`), and bash expands those into literal
`-JobId`/`-RelayBase` args before `powershell.exe` even starts. Once
`restart-agent.ps1` confirms the new `CcswAgent` process is up, it POSTs
the job's result (`RESTARTED`, or a `RESTART-FAILED` message if the new
process never appeared) straight to `result.php` via `curl.exe`,
independent of whatever the now-dead old process managed to post itself.

Use this after editing `AgentCore.cs`/`Program.cs`/etc. and rebuilding, to
pick up the new build without needing physical/RDP access to the VM.
