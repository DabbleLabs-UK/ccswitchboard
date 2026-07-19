//go:build windows

// Command ccsw-relay is a Windows system-tray "desktop relay" launcher for the
// self-hosted CCSwitchboard system. It starts a bundled PHP web app plus a
// Cloudflare Quick Tunnel and exposes control via a tray icon and menu.
//
// It uses the Go standard library only; all GUI/tray work is done through raw
// Win32 calls (see win32.go / tray.go).
package main

import (
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
)

// appVersion is stamped into the log, the tray tooltip, and the menu so the
// running build is always identifiable at a glance.
const appVersion = "0.9"

// phpWorkerCount is how many php -S processes serve behind the proxy. Each is
// single-threaded; four in a pool keeps job-output fetches and manual sends
// responsive while the VM agent's poll traffic churns away in parallel.
const phpWorkerCount = 4

func main() {
	// The Win32 window and its message pump must live on a single OS thread,
	// so pin the main goroutine. (runtime is part of the standard library; no
	// external module or network access is involved.)
	runtime.LockOSThread()

	exePath, err := os.Executable()
	if err != nil {
		msgBox("Could not determine executable path:\n"+err.Error(),
			"CCSwitchboard Relay", MB_OK|MB_ICONERROR)
		os.Exit(1)
	}
	exeDir := filepath.Dir(exePath)

	initLog(filepath.Join(exeDir, "ccsw-relay.log"))
	logf("=== CCSwitchboard Relay v%s starting ===", appVersion)
	logf("exe:    %s", exePath)
	logf("exeDir: %s", exeDir)

	// 2. Locate php.exe (required).
	phpPath = findPHP(exeDir)
	if phpPath == "" {
		logf("php.exe not found")
		msgBox("PHP not found — put php.exe next to this app (or in a \"php\" "+
			"subfolder), or install PHP (e.g. winget install PHP.PHP.NTS.8.4).",
			"CCSwitchboard Relay", MB_OK|MB_ICONERROR)
		os.Exit(1)
	}
	logf("php: %s", phpPath)

	// 3. Locate cloudflared.exe (optional).
	cloudflaredPath = findCloudflared(exeDir)
	if cloudflaredPath == "" {
		logf("cloudflared.exe not found (local only)")
	} else {
		logf("cloudflared: %s", cloudflaredPath)
	}

	// 4. Load config, then set up the writable data dir (holds the SQLite DB,
	// the auto-generated token, and — in the self-contained default — the
	// extracted relay web-root).
	cfg := loadConfig(exeDir)
	if cfg.DataDir != "" {
		dataDir = cfg.DataDir
	} else {
		dataDir = filepath.Join(exeDir, "data")
	}
	if err := os.MkdirAll(dataDir, 0o775); err != nil {
		logf("could not create data dir %q: %v", dataDir, err)
	}
	dbPath = filepath.Join(dataDir, "jobs.sqlite")
	logf("data dir: %s (CCSW_DB_PATH=%s)", dataDir, dbPath)

	// Docroot: an explicit config docroot wins; otherwise self-extract the
	// bundled relay under <dataDir>/webroot so the app is fully self-contained
	// (no local WAMP / junction needed). The bundled copy lands at
	// webroot/ccswitchboard/board, i.e. it serves at that sub-path — which is
	// exactly what the relay's login-cookie path requires.
	basePath = normalizeBasePath(cfg.BasePath)
	if cfg.Docroot != "" {
		docroot = cfg.Docroot
	} else {
		webroot := filepath.Join(dataDir, "webroot")
		if err := extractEmbeddedRelay(webroot); err != nil {
			logf("failed to extract bundled relay: %v", err)
			msgBox("Failed to unpack the bundled relay:\n"+err.Error(),
				"CCSwitchboard Relay", MB_OK|MB_ICONERROR)
			os.Exit(1)
		}
		docroot = webroot
		if basePath == "" {
			basePath = "/ccswitchboard/board"
		}
		logf("using bundled relay, extracted to %s", webroot)
	}
	tunnelToken = cfg.TunnelToken
	configuredPublicURL = cfg.PublicURL
	logf("docroot: %s", docroot)
	logf("basePath: %q (board served at <url>%s/)", basePath, basePath)
	if tunnelToken != "" {
		logf("named-tunnel mode: stable publicUrl=%s", configuredPublicURL)
	}

	// 5. Ports: listenPort is the public port cloudflared targets (fixed from
	// config for a named tunnel, else OS-assigned); php runs on a separate
	// internal port behind the serializing reverse proxy.
	if cfg.Port > 0 {
		listenPort = cfg.Port
	} else {
		port, err := freePort()
		if err != nil {
			logf("could not find a free port: %v", err)
			msgBox("Could not find a free TCP port:\n"+err.Error(),
				"CCSwitchboard Relay", MB_OK|MB_ICONERROR)
			os.Exit(1)
		}
		listenPort = port
	}
	pps, err := freePorts(phpWorkerCount)
	if err != nil {
		logf("could not find free php ports: %v", err)
		msgBox("Could not find free TCP ports:\n"+err.Error(),
			"CCSwitchboard Relay", MB_OK|MB_ICONERROR)
		os.Exit(1)
	}
	phpPorts = pps
	localURL = fmt.Sprintf("http://127.0.0.1:%d", listenPort)
	logf("ports: public=%d php=%v", listenPort, phpPorts)
	logf("local URL: %s", localURL)

	// 6. Start PHP.
	if err := startPHP(); err != nil {
		logf("failed to start php: %v", err)
		msgBox("Failed to start PHP:\n"+err.Error(),
			"CCSwitchboard Relay", MB_OK|MB_ICONERROR)
		os.Exit(1)
	}

	// Start the reverse proxy (public port -> php), which feeds single-threaded
	// php one request at a time so cloudflared's parallel fetches don't 502.
	go func() {
		if err := startProxy(); err != nil {
			logf("proxy exited: %v", err)
		}
	}()

	// Poke the relay so it generates its token file, then load the token
	// (used by "Copy relay token" and the auto-login "Open dashboard").
	go warmRelay()

	// 8. Tray: create the hidden window and add the icon.
	if err := createWindow(); err != nil {
		logf("failed to create window: %v", err)
		msgBox("Failed to create the tray window:\n"+fmt.Sprint(err),
			"CCSwitchboard Relay", MB_OK|MB_ICONERROR)
		killChildren()
		os.Exit(1)
	}
	addIcon("CCSwitchboard Relay v" + appVersion + " — " + localURL)
	logf("tray icon added")

	// 7. Start the tunnel (only if cloudflared was found).
	if cloudflaredPath == "" {
		setStatus("tunnel: cloudflared not found (local only)")
	} else {
		go startTunnel()
	}

	// 10. Graceful shutdown on Interrupt (best-effort; GUI apps rarely receive
	// console signals, but install it as specified).
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt)
	go func() {
		<-sigCh
		logf("interrupt received, shutting down")
		killChildren()
		deleteIcon()
		os.Exit(0)
	}()

	logf("entering message loop")
	messageLoop()

	// Reached after WM_QUIT.
	logf("message loop ended, cleaning up")
	killChildren()
	deleteIcon()
	logf("=== CCSwitchboard Relay stopped ===")
}
