# CCSwitchboard agent installer -- machine: {{MACHINE}}
#
# Rendered per-machine by the relay's machine_installer.php from
# board/installer-template.ps1. The {{RELAY_BASE}} / {{TOKEN}} / {{MACHINE}}
# placeholders are filled in at download time from that machine's `machines`
# row, so THIS FILE IS A SECRET once rendered -- it carries the machine's relay
# token in clear text. Do not commit, paste or forward the downloaded copy.
#
# Run on the NEW Windows machine:
#   powershell -ExecutionPolicy Bypass -File install-ccsw-{{MACHINE}}.ps1
#
# Every step checks whether it is already satisfied and skips if so, so this is
# safe to re-run -- after a failure, on a half-provisioned box, or to upgrade
# the agent in place.

$ErrorActionPreference = 'Stop'

$RelayBase  = '{{RELAY_BASE}}'
$Token      = '{{TOKEN}}'
$Machine    = '{{MACHINE}}'
$InstallDir = 'C:\CcswAgent'
$BashPath   = 'C:\Program Files\Git\bin\bash.exe'
$TaskName   = 'CcswAgent'

$script:Failures = @()

function Write-Step   ($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok     ($m) { Write-Host "    OK: $m" -ForegroundColor Green }
function Write-Skip   ($m) { Write-Host "    SKIP: $m" -ForegroundColor DarkGray }
function Write-Fail   ($m) {
    Write-Host "    FAILED: $m" -ForegroundColor Red
    $script:Failures += $m
}

# winget marks a package installed in the registry, but the CURRENT shell keeps
# the PATH it started with -- so `git`/`node` stay "not found" here until we
# rebuild PATH from the registry ourselves. Without this the npm step below
# fails on a box that just installed Node seconds earlier.
function Update-PathFromRegistry {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ';'
}

function Test-WingetPackage ($id) {
    # `winget list --id X` exits 0 and echoes the package when present, and
    # exits non-zero ("No installed package found") when not. --exact stops a
    # prefix match reporting a sibling package as this one.
    $null = winget list --id $id --exact --accept-source-agreements 2>&1
    return ($LASTEXITCODE -eq 0)
}

function Install-WingetPackage ($id, $label) {
    Write-Step "$label ($id)"
    if (Test-WingetPackage $id) {
        Write-Skip "$label already installed"
        return
    }
    try {
        winget install --id $id --exact --silent `
            --accept-package-agreements --accept-source-agreements `
            --disable-interactivity 2>&1 | ForEach-Object { Write-Host "    $_" }
        if ($LASTEXITCODE -ne 0) { throw "winget exited $LASTEXITCODE" }
        Update-PathFromRegistry
        Write-Ok "$label installed"
    } catch {
        Write-Fail "$label -- $_"
    }
}

Write-Host "CCSwitchboard agent installer" -ForegroundColor White
Write-Host "  machine : $Machine"
Write-Host "  relay   : $RelayBase"
Write-Host "  target  : $InstallDir"

# --- 0. Preflight ----------------------------------------------------------
Write-Step 'Checking winget is available'
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host @'
    FAILED: winget not found.
    winget ships with App Installer. Install it from the Microsoft Store
    ("App Installer"), then re-run this script.
'@ -ForegroundColor Red
    exit 1
}
Write-Ok 'winget present'

# --- 1. Prerequisites ------------------------------------------------------
# Not fatal on failure: a box may already have any of these from another source
# (Git via the standalone installer, Node via nvm), in which case winget says
# "not installed" but the tool works fine. The checks that actually matter --
# bash.exe existing, npm running -- happen at their own steps below.
Install-WingetPackage 'Microsoft.DotNet.DesktopRuntime.10' '.NET 10 Desktop Runtime'
Install-WingetPackage 'Git.Git'                            'Git'
Install-WingetPackage 'OpenJS.NodeJS.LTS'                  'Node.js LTS'

Update-PathFromRegistry

# --- 2. Claude Code --------------------------------------------------------
Write-Step 'Claude Code CLI (@anthropic-ai/claude-code)'
if (Get-Command claude -ErrorAction SilentlyContinue) {
    Write-Skip 'claude already on PATH'
} elseif (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Fail 'npm not found -- Node.js install did not take. Re-run this script in a NEW shell.'
} else {
    try {
        npm install -g @anthropic-ai/claude-code 2>&1 | ForEach-Object { Write-Host "    $_" }
        if ($LASTEXITCODE -ne 0) { throw "npm exited $LASTEXITCODE" }
        Update-PathFromRegistry
        Write-Ok 'Claude Code installed'
    } catch {
        Write-Fail "Claude Code -- $_"
    }
}

# --- 3. Agent binaries -----------------------------------------------------
# The zip is served by the relay's download.php, which requires this machine's
# token -- a bare static file would put the agent binaries behind no auth at
# all. Invoke-WebRequest throws on a non-2xx, so a 401 here surfaces loudly
# rather than writing an HTML error page to disk as "agent-win.zip".
Write-Step "Downloading agent from $RelayBase/download.php"
$zipPath = Join-Path $env:TEMP 'ccsw-agent-win.zip'
$agentDownloaded = $false
try {
    $ProgressPreference = 'SilentlyContinue'  # progress UI makes IWR ~10x slower
    Invoke-WebRequest -Uri "$RelayBase/download.php?file=agent-win.zip" `
        -Headers @{ 'X-CCSW-Token' = $Token } `
        -OutFile $zipPath -UseBasicParsing
    $size = (Get-Item $zipPath).Length
    if ($size -le 0) { throw 'downloaded zip is empty' }
    Write-Ok ("downloaded {0:N0} bytes" -f $size)
    $agentDownloaded = $true
} catch {
    Write-Fail "agent download -- $_"
}

if ($agentDownloaded) {
    Write-Step "Installing agent to $InstallDir"
    try {
        # Stop a running agent first: Expand-Archive cannot overwrite a loaded
        # CcswAgent.exe, so an in-place upgrade fails on a locked file otherwise.
        Get-Process CcswAgent -ErrorAction SilentlyContinue | Stop-Process -Force
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        Expand-Archive -Path $zipPath -DestinationPath $InstallDir -Force
        Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
        Write-Ok "unpacked to $InstallDir"
    } catch {
        Write-Fail "unpack -- $_"
    }
}

# --- 4. Agent config -------------------------------------------------------
# Key names must match CcswAgent's AgentConfig record (agent/CcswAgent/
# AgentCore.cs). Deserialisation is case-insensitive, but these are written in
# the same camelCase as agent.config.example.json so the file reads the same on
# every box. Always rewritten, even on re-run: it is derived entirely from this
# script's own values, so a rewrite is how a rotated token gets applied.
Write-Step 'Writing agent.config.json'
try {
    $config = [ordered]@{
        machine     = $Machine
        relayBase   = $RelayBase
        workerCount = 4
        bashPath    = $BashPath
        token       = $Token
    }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $configPath = Join-Path $InstallDir 'agent.config.json'
    # -Encoding utf8 on PS 5.1 writes a BOM, which System.Text.Json rejects
    # outright ("'0xEF' is invalid start of a value") -- the agent would refuse
    # its own config. WriteAllText with a no-BOM encoding is what avoids that.
    [IO.File]::WriteAllText(
        $configPath,
        ($config | ConvertTo-Json),
        (New-Object Text.UTF8Encoding $false))
    if (-not (Test-Path $BashPath)) {
        Write-Host "    NOTE: $BashPath not found -- bash jobs will fail until Git is installed there." -ForegroundColor Yellow
    }
    Write-Ok "wrote $configPath"
} catch {
    Write-Fail "agent.config.json -- $_"
}

# --- 5. Run at logon -------------------------------------------------------
Write-Step "Registering scheduled task '$TaskName' (at logon)"
try {
    $exe = Join-Path $InstallDir 'CcswAgent.exe'
    # /f overwrites an existing task, making re-runs idempotent. The agent is a
    # tray app and must run in the interactive session, so this is /sc onlogon
    # and NOT a service -- a session-0 service would have no tray and no access
    # to the user's Claude Code login.
    schtasks /create /tn $TaskName /sc onlogon /tr "`"$exe`"" /f 2>&1 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "schtasks exited $LASTEXITCODE" }
    Write-Ok "task '$TaskName' registered"
} catch {
    Write-Fail "scheduled task -- $_"
}

# --- 6. Start it now -------------------------------------------------------
Write-Step 'Starting the agent'
try {
    $exe = Join-Path $InstallDir 'CcswAgent.exe'
    if (-not (Test-Path $exe)) { throw "$exe not found" }
    if (Get-Process CcswAgent -ErrorAction SilentlyContinue) {
        Write-Skip 'agent already running'
    } else {
        Start-Process -FilePath $exe -WorkingDirectory $InstallDir
        Write-Ok 'agent started (look for the tray icon)'
    }
} catch {
    Write-Fail "start agent -- $_"
}

# --- Done ------------------------------------------------------------------
Write-Host ''
if ($script:Failures.Count -gt 0) {
    Write-Host '--- Finished WITH ERRORS ---' -ForegroundColor Red
    foreach ($f in $script:Failures) { Write-Host "  * $f" -ForegroundColor Red }
    Write-Host 'Fix the above and re-run this script -- completed steps are skipped.' -ForegroundColor Yellow
} else {
    Write-Host '--- Install complete ---' -ForegroundColor Green
}

Write-Host @"

ONE MANUAL STEP LEFT
--------------------
Claude Code needs an interactive login, which cannot be scripted. Open a new
terminal on this machine and run:

    claude

Sign in when prompted, then close it. The agent will pick up jobs targeted at
'$Machine' from there on -- it should already be showing on the board's
Machines page.
"@ -ForegroundColor White

if ($script:Failures.Count -gt 0) { exit 1 }
