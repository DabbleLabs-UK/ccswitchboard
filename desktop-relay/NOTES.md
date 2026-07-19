# ccsw-relay — desktop relay launcher

A Windows system-tray app (Go, standard library only, raw Win32) that launches a
bundled PHP web app and a Cloudflare Quick Tunnel for the self-hosted
**CCSwitchboard** system, and exposes control through a tray icon + menu.

## What it does at startup

1. Determines `exeDir = filepath.Dir(os.Executable())`.
2. Creates/truncates the log file `<exeDir>\ccsw-relay.log`.
3. Locates `php.exe` (required — see below).
4. Locates `cloudflared.exe` (optional — see below).
5. Picks the document root (see below).
6. Asks the OS for a free `127.0.0.1` TCP port.
7. Starts `php.exe -S 127.0.0.1:<port> -t <docroot>`.
8. Creates a hidden Win32 window and adds the tray icon.
9. If cloudflared was found, starts `cloudflared tunnel --no-autoupdate --url
   http://127.0.0.1:<port>` and watches its output for the public URL.

## How it locates php.exe

Checked in this order; first hit wins. If none is found, a message box is shown
("PHP not found — put php.exe next to this app…") and the app exits.

1. `<exeDir>\php\php.exe`
2. `<exeDir>\php.exe`
3. `php` on `PATH` (`exec.LookPath`)
4. `%LOCALAPPDATA%\Microsoft\WinGet\Packages\PHP.PHP.NTS.8.4*\*\php.exe`
5. `%LOCALAPPDATA%\Microsoft\WinGet\Packages\PHP.PHP.NTS.8.4*\php.exe`

(4) and (5) use `filepath.Glob`; the first match is used.

## How it locates cloudflared.exe

Checked in this order; first hit wins. If **none** is found the app does **not**
exit — PHP still runs, the status becomes
`tunnel: cloudflared not found (local only)`, and the "Copy public URL" /
"Restart tunnel" menu items are grayed out.

1. `<exeDir>\cloudflared.exe`
2. `cloudflared` on `PATH` (`exec.LookPath`)
3. `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Cloudflare.cloudflared*\*\cloudflared.exe`

## Document root (how to set it)

The doc root is the first existing directory among these, next to the exe:

1. `<exeDir>\relay`
2. `<exeDir>\board`
3. `<exeDir>\www`

If none of those exist, `exeDir` itself is used. **To point the relay at your
PHP app, drop it into a `relay` (or `board` / `www`) folder beside
`ccsw-relay.exe`.**

## Log file

`<exeDir>\ccsw-relay.log`, recreated (truncated) on every launch. It contains
timestamped lines for every significant event plus every line of child-process
output, tagged `[php]` and `[cloudflared]`. Open it any time from the tray menu
via **Open log**.

## Tray menu

- `Relay: http://127.0.0.1:<port>` (info, grayed)
- `Tunnel: <public url>` / `Tunnel: starting…` / `Tunnel: not available` (info, grayed)
- ─────────
- **Copy public URL** (grayed until the tunnel URL is known)
- **Open dashboard** (opens the public URL if known, otherwise the local URL)
- **Open log**
- **Restart tunnel** (grayed if cloudflared is missing)
- ─────────
- **Quit** (kills PHP + cloudflared, removes the icon, exits)

## Build (cross-compile from Linux to Windows)

```
cd /path/to/ccsw-relay
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "-H=windowsgui -s -w" -o ccsw-relay.exe .
```

Produces a GUI-subsystem `PE32+ executable (GUI) x86-64`. No cgo, no external
modules — Go standard library only.

## Implementation notes

- All GUI/tray/clipboard work is raw Win32 via `syscall.NewLazyDLL` /
  `(*LazyProc).Call` / `syscall.NewCallback`. No third-party packages.
- Win32 structs (`NOTIFYICONDATAW`, `WNDCLASSEXW`, `MSG`, `POINT`, `GUID`) are
  naturally aligned; verified sizes for windows/amd64: `MSG`=48, `WNDCLASSEXW`=80,
  `GUID`=16, `NOTIFYICONDATAW`=976. `cbSize`/`CbSize` fields are set from
  `unsafe.Sizeof`.
- The tray callback checks `LOWORD(lParam)` against `WM_RBUTTONUP` /
  `WM_LBUTTONUP` / `WM_CONTEXTMENU`. This works for both the legacy and the
  version-4 shell callback conventions, so `NIM_SETVERSION` is not required.
- The context menu is built on demand and shown with
  `TrackPopupMenu(..., TPM_RETURNCMD, ...)`, which returns the chosen command id
  directly — no `WM_COMMAND` handling needed.
- The main goroutine is pinned with `runtime.LockOSThread()` before the window
  is created, so the window and its `GetMessage`/`Dispatch` pump stay on one OS
  thread (a hard requirement for Win32 UI). `runtime` is part of the Go standard
  library; it involves no external module and no network access.
- Child processes are launched with `CREATE_NO_WINDOW` so no console window
  flashes. Their stdout/stderr are streamed line-by-line into the log.
- Clipboard text is copied into `GMEM_MOVEABLE` global memory via
  `RtlMoveMemory` and handed to `SetClipboardData(CF_UNICODETEXT, …)`; that
  memory is intentionally **not** freed (the system owns it).
- Graceful shutdown: an `os/signal` handler (Interrupt) kills the children and
  removes the icon; the Quit menu item and every fatal path also kill
  PHP + cloudflared so no orphaned tunnel/server remains.

## Current limitations

- **No custom icon** — uses the stock `IDI_APPLICATION` system icon. To ship a
  branded icon you'd add an `.ico` resource (e.g. via a `.syso` built by
  `windres`/`rsrc`) and `LoadImage`/`LoadIconW` it.
- **No Job Object** — children are tracked and killed on normal quit / signal /
  fatal exit, but if the relay process is force-killed (Task Manager "End task",
  a hard crash) the PHP server and cloudflared tunnel can be orphaned. Wrapping
  the children in a Windows Job Object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` would make the OS reap them
  automatically; it is not implemented yet.
- **Console signals** — the Interrupt handler is installed as specified, but a
  `-H=windowsgui` app has no console, so Ctrl-C/Ctrl-Break are not normally
  delivered. Real shutdown happens through the **Quit** menu item.
- **Single instance** — nothing prevents launching two copies; each would start
  its own PHP server (on its own port) and its own tunnel.
