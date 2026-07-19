//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

var (
	logMu   sync.Mutex
	logFile *os.File
	logPath string
)

// initLog creates/truncates the log file at path.
func initLog(path string) {
	logPath = path
	f, err := os.Create(path)
	if err != nil {
		msgBox("Could not create log file:\n"+path+"\n\n"+err.Error(),
			"CCSwitchboard Relay", MB_OK|MB_ICONERROR)
		return
	}
	logFile = f
}

// logf writes a timestamped line to the log file.
func logf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	ts := time.Now().Format("2006-01-02 15:04:05.000")
	logMu.Lock()
	defer logMu.Unlock()
	if logFile != nil {
		fmt.Fprintf(logFile, "%s %s\n", ts, line)
	}
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

var (
	// Set once during startup, read-only afterwards.
	localURL        string
	phpPath         string
	cloudflaredPath string
	docroot             string
	dataDir             string
	dbPath              string
	basePath            string // URL sub-path the board is served under ("" = root)
	tunnelToken         string // Cloudflare named-tunnel token ("" = quick tunnel)
	configuredPublicURL string // stable public URL for named-tunnel mode
	listenPort          int    // public port cloudflared targets (the reverse proxy)
	phpPorts            []int  // internal ports the php -S workers listen on (behind the proxy)

	// Mutex-guarded runtime state.
	stateMu    sync.Mutex
	status     string
	publicURL  string
	relayToken string

	phpCmds []*exec.Cmd

	cfMu      sync.Mutex
	cfCmd     *exec.Cmd
	tunnelGen atomic.Int64
)

func setStatus(s string) {
	stateMu.Lock()
	status = s
	stateMu.Unlock()
	logf("status: %s", s)
}

func setPublicURL(u string) {
	stateMu.Lock()
	publicURL = u
	stateMu.Unlock()
}

func getPublicURL() string {
	stateMu.Lock()
	defer stateMu.Unlock()
	return publicURL
}

func getRelayToken() string {
	stateMu.Lock()
	defer stateMu.Unlock()
	return relayToken
}

// tokenRe extracts the primary token from the relay's auto-generated
// auth.config.php, whose body looks like: return ['token' => '<64 hex>'];
var tokenRe = regexp.MustCompile(`['"]token['"]\s*=>\s*['"]([0-9a-fA-F]{32,})['"]`)

// readRelayToken reads the primary token from <dataDir>/auth.config.php. Returns
// "" if the relay hasn't generated it yet (it writes the file on the first
// request that checks auth — see warmRelay, which triggers that).
func readRelayToken() string {
	if dataDir == "" {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(dataDir, "auth.config.php"))
	if err != nil {
		return ""
	}
	if m := tokenRe.FindSubmatch(b); m != nil {
		return string(m[1])
	}
	return ""
}

// warmRelay pokes the local relay once so php generates auth.config.php (the
// token file), then loads the token into shared state. This makes "Copy relay
// token" and the auto-login "Open dashboard" work from the first menu open.
// The token itself is never logged — only its presence/length.
func warmRelay() {
	client := &http.Client{Timeout: 5 * time.Second}
	for i := 0; i < 12; i++ {
		if resp, err := client.Get(localURL + basePath + "/"); err == nil {
			resp.Body.Close()
			if t := readRelayToken(); t != "" {
				stateMu.Lock()
				relayToken = t
				stateMu.Unlock()
				logf("relay token loaded (%d chars)", len(t))
				return
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	logf("warmRelay: token not detected after warm-up (open the dashboard once to generate it)")
}

// ---------------------------------------------------------------------------
// Child process output plumbing
// ---------------------------------------------------------------------------

// readCloser matches the *Pipe() return value without importing "io".
type readCloser interface {
	Read(p []byte) (int, error)
}

// logLines scans r line-by-line and writes each line to the log with tag.
func logLines(tag string, r readCloser) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		logf("%s %s", tag, sc.Text())
	}
}

// ---------------------------------------------------------------------------
// Discovery helpers
// ---------------------------------------------------------------------------

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}

func isDir(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}

// findPHP locates php.exe. Order: <exeDir>\php\php.exe, <exeDir>\php.exe,
// PATH, then the WinGet PHP.PHP.NTS.8.4* package locations.
func findPHP(exeDir string) string {
	for _, c := range []string{
		filepath.Join(exeDir, "php", "php.exe"),
		filepath.Join(exeDir, "php.exe"),
	} {
		if fileExists(c) {
			return c
		}
	}
	if p, err := exec.LookPath("php"); err == nil {
		return p
	}
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		for _, pat := range []string{
			filepath.Join(local, "Microsoft", "WinGet", "Packages", "PHP.PHP.NTS.8.4*", "*", "php.exe"),
			filepath.Join(local, "Microsoft", "WinGet", "Packages", "PHP.PHP.NTS.8.4*", "php.exe"),
		} {
			if matches, _ := filepath.Glob(pat); len(matches) > 0 {
				return matches[0]
			}
		}
	}
	return ""
}

// findCloudflared locates cloudflared.exe. Order: <exeDir>\cloudflared.exe,
// PATH, then the WinGet Cloudflare.cloudflared* package location.
func findCloudflared(exeDir string) string {
	if c := filepath.Join(exeDir, "cloudflared.exe"); fileExists(c) {
		return c
	}
	if p, err := exec.LookPath("cloudflared"); err == nil {
		return p
	}
	// The winget "Cloudflare.cloudflared" package is an MSI: it drops
	// cloudflared.exe into a Program Files\cloudflared dir and only updates the
	// system PATH -- which a double-clicked (Explorer-launched) instance won't
	// see until the user logs back in. Check those install dirs directly so
	// double-click works without launching from a fresh terminal.
	for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"} {
		if base := os.Getenv(env); base != "" {
			if c := filepath.Join(base, "cloudflared", "cloudflared.exe"); fileExists(c) {
				return c
			}
		}
	}
	if local := os.Getenv("LOCALAPPDATA"); local != "" {
		pat := filepath.Join(local, "Microsoft", "WinGet", "Packages", "Cloudflare.cloudflared*", "*", "cloudflared.exe")
		if matches, _ := filepath.Glob(pat); len(matches) > 0 {
			return matches[0]
		}
	}
	return ""
}

// extractEmbeddedRelay writes the embedded relay tree out under destRoot so
// php -S can execute it (embed.FS files aren't real files on disk). The tree
// lands as destRoot/ccswitchboard/board/... Overwrites on every launch, so a
// version upgrade always refreshes the served copy.
func extractEmbeddedRelay(destRoot string) error {
	return fs.WalkDir(embeddedRelay, "webroot", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel("webroot", p)
		if err != nil {
			return err
		}
		target := filepath.Join(destRoot, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o775)
		}
		data, err := embeddedRelay.ReadFile(p)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o775); err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}

// findDocroot returns the first existing relay/board/www dir next to the exe,
// falling back to exeDir itself.
func findDocroot(exeDir string) string {
	for _, d := range []string{"relay", "board", "www"} {
		p := filepath.Join(exeDir, d)
		if isDir(p) {
			return p
		}
	}
	return exeDir
}

// freePort asks the OS for an ephemeral TCP port, then releases it.
func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// freePorts allocates n distinct free ports. All listeners are held open until
// every port is claimed, so the OS cannot hand the same port out twice (which
// sequential freePort calls would in principle allow).
func freePorts(n int) ([]int, error) {
	listeners := make([]net.Listener, 0, n)
	defer func() {
		for _, l := range listeners {
			l.Close()
		}
	}()
	ports := make([]int, 0, n)
	for i := 0; i < n; i++ {
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, err
		}
		listeners = append(listeners, l)
		ports = append(ports, l.Addr().(*net.TCPAddr).Port)
	}
	return ports, nil
}

// hideChild ensures a launched console child does not pop up a console window.
func hideChild(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: CREATE_NO_WINDOW}
}

// ---------------------------------------------------------------------------
// Optional config: relay.config.json next to the exe
// ---------------------------------------------------------------------------

type relayConfig struct {
	Docroot  string `json:"docroot"`  // the PHP document root
	DataDir  string `json:"dataDir"`  // writable dir for jobs.sqlite + auth.config.php
	BasePath string `json:"basePath"` // URL sub-path the board is served under, e.g. /ccswitchboard/board (matches the relay's cookie path). Empty = served at root.

	// Stable named-tunnel mode. When TunnelToken is set the app runs a
	// Cloudflare *named* tunnel (a fixed public URL that never changes)
	// instead of an ephemeral quick tunnel. Port must be fixed and must match
	// the hostname->localhost:PORT ingress configured on the Cloudflare side;
	// PublicURL is that stable hostname (e.g. https://relay.example.com).
	Port        int    `json:"port"`
	TunnelToken string `json:"tunnelToken"`
	PublicURL   string `json:"publicUrl"`
}

// normalizeBasePath returns a clean sub-path: "" (root) or "/seg/seg" with a
// leading slash and no trailing slash.
func normalizeBasePath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" || p == "/" {
		return ""
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return strings.TrimRight(p, "/")
}

// loadConfig reads relay.config.json from exeDir if present (missing file or a
// parse error just yields defaults). CCSW_DOCROOT / CCSW_DATA_DIR env vars, if
// set, override the file — handy for quick tests without editing anything.
func loadConfig(exeDir string) relayConfig {
	var c relayConfig
	p := filepath.Join(exeDir, "relay.config.json")
	if b, err := os.ReadFile(p); err == nil {
		if err := json.Unmarshal(b, &c); err != nil {
			logf("relay.config.json parse error: %v", err)
		} else {
			logf("loaded relay.config.json: docroot=%q dataDir=%q", c.Docroot, c.DataDir)
		}
	}
	if v := os.Getenv("CCSW_DOCROOT"); v != "" {
		c.Docroot = v
	}
	if v := os.Getenv("CCSW_DATA_DIR"); v != "" {
		c.DataDir = v
	}
	c.PublicURL = strings.TrimRight(strings.TrimSpace(c.PublicURL), "/")
	return c
}

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

// startPHP launches one bundled PHP built-in web server per worker port.
// Windows php.exe has no PHP_CLI_SERVER_WORKERS, so real concurrency comes
// from running several single-threaded php -S processes side by side; the
// reverse proxy load-balances across them. SQLite cross-process contention is
// handled by the relay's own PRAGMA busy_timeout=5000 (db.php), the same way
// it already runs under multi-process Apache on prod.
func startPHP() error {
	for i, port := range phpPorts {
		cmd := exec.Command(phpPath, "-S", fmt.Sprintf("127.0.0.1:%d", port), "-t", docroot)
		// The relay's db.php reads CCSW_DB_PATH to locate its SQLite store; the
		// containing dir also holds the auto-generated auth.config.php (token),
		// lock and log. .htaccess sets this on prod, but php -S ignores
		// .htaccess, so we inject it here to point everything at a writable
		// data dir.
		cmd.Env = append(os.Environ(), "CCSW_DB_PATH="+dbPath)
		hideChild(cmd)

		stdout, err := cmd.StdoutPipe()
		if err != nil {
			return err
		}
		stderr, err := cmd.StderrPipe()
		if err != nil {
			return err
		}
		if err := cmd.Start(); err != nil {
			return err
		}
		phpCmds = append(phpCmds, cmd)
		tag := fmt.Sprintf("[php#%d]", i)
		logf("php worker %d started (pid=%d): %q -S 127.0.0.1:%d -t %q",
			i, cmd.Process.Pid, phpPath, port, docroot)

		go logLines(tag, stdout)
		go logLines(tag, stderr)
		c := cmd
		go func() {
			c.Wait()
			logf("php worker (pid=%d) exited", c.Process.Pid)
		}()
	}
	return nil
}

// ---------------------------------------------------------------------------
// Reverse proxy (listenPort -> php on phpPort)
// ---------------------------------------------------------------------------

// startProxy serves the public listenPort and reverse-proxies to a POOL of
// php -S workers. Each individual php -S process is single-threaded and
// Windows php.exe handles concurrent connections on one socket unreliably
// (resets -> Cloudflare 502 <!DOCTYPE pages), so each worker still sees ONE
// request at a time — but there are several workers, so a slow request (a big
// job-output fetch, a manual send) no longer wedges behind the agent's
// constant poll traffic. v0.8's single serialized worker caused exactly that:
// head-of-line blocking that made output loads and deliveries "take forever"
// and time out. A free-list channel hands each request the first idle worker
// (least-busy scheduling); requests only queue when ALL workers are busy.
// Blocks; run in a goroutine.
func startProxy() error {
	type backend struct {
		rp *httputil.ReverseProxy
	}
	backends := make([]backend, len(phpPorts))
	free := make(chan int, len(phpPorts))
	for i, port := range phpPorts {
		target, err := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", port))
		if err != nil {
			return err
		}
		rp := httputil.NewSingleHostReverseProxy(target)
		rp.Transport = &http.Transport{
			DialContext:           (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
			ResponseHeaderTimeout: 60 * time.Second,
			MaxIdleConns:          2,
			IdleConnTimeout:       30 * time.Second,
		}
		rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, e error) {
			logf("proxy error for %s: %v", r.URL.Path, e)
			w.WriteHeader(http.StatusBadGateway)
		}
		backends[i] = backend{rp: rp}
		free <- i
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		idx := <-free // first idle php worker; blocks only when all are busy
		defer func() { free <- idx }()
		backends[idx].rp.ServeHTTP(w, r)
	})
	srv := &http.Server{Addr: fmt.Sprintf("127.0.0.1:%d", listenPort), Handler: handler}
	logf("proxy listening on 127.0.0.1:%d -> %d php workers %v (1 req/worker)",
		listenPort, len(phpPorts), phpPorts)
	return srv.ListenAndServe()
}

// ---------------------------------------------------------------------------
// Cloudflare Quick Tunnel
// ---------------------------------------------------------------------------

var tunnelURLRe = regexp.MustCompile(`https://[a-z0-9-]+\.trycloudflare\.com`)

// startTunnel launches "cloudflared tunnel --url http://127.0.0.1:<port>",
// scans its stderr for the public URL and updates the tray. It is safe to run
// repeatedly (e.g. from "Restart tunnel"); a generation counter keeps a
// superseded goroutine from clobbering the newer one's status.
func startTunnel() {
	if cloudflaredPath == "" {
		return
	}
	myGen := tunnelGen.Add(1)

	// Named-tunnel mode (stable URL) when a token is configured; otherwise a
	// zero-config quick tunnel with an ephemeral trycloudflare.com URL.
	named := tunnelToken != ""
	var cmd *exec.Cmd
	if named {
		cmd = exec.Command(cloudflaredPath, "tunnel", "--no-autoupdate", "run", "--token", tunnelToken)
	} else {
		cmd = exec.Command(cloudflaredPath, "tunnel", "--no-autoupdate", "--url", localURL)
	}
	hideChild(cmd)

	// cloudflared logs to stderr.
	stderr, err := cmd.StderrPipe()
	if err != nil {
		logf("tunnel: StderrPipe error: %v", err)
		setStatus("tunnel: error")
		return
	}
	if err := cmd.Start(); err != nil {
		logf("tunnel: start error: %v", err)
		setStatus("tunnel: failed to start")
		return
	}

	cfMu.Lock()
	cfCmd = cmd
	cfMu.Unlock()

	setStatus("tunnel: starting")
	logf("tunnel started (pid=%d, named=%v) -> %s", cmd.Process.Pid, named, localURL)

	// A named tunnel does not print a trycloudflare URL — its public URL is the
	// fixed hostname configured on the Cloudflare side, so publish it now.
	found := false
	if named {
		if configuredPublicURL != "" {
			setPublicURL(configuredPublicURL)
			setStatus("tunnel: online (stable)")
			updateTip("CCSwitchboard Relay v" + appVersion + " — " + configuredPublicURL)
			showBalloon("CCSwitchboard Relay", "Relay online (stable) — "+configuredPublicURL)
			logf("named tunnel public URL: %s", configuredPublicURL)
		}
		found = true // no trycloudflare URL to scan for
	}
	sc := bufio.NewScanner(stderr)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		logf("[cloudflared] %s", line)
		if !found {
			if m := tunnelURLRe.FindString(line); m != "" {
				found = true
				setPublicURL(m)
				setStatus("tunnel: online")
				updateTip("CCSwitchboard Relay — " + m)
				showBalloon("CCSwitchboard Relay", "Relay online — "+m)
				logf("public URL detected: %s", m)
			}
		}
	}

	cmd.Wait()
	if tunnelGen.Load() == myGen {
		setStatus("tunnel down")
		logf("tunnel process exited")
	} else {
		logf("tunnel process exited (superseded by a restart)")
	}
}

// restartTunnel kills the current cloudflared (if any) and starts a new tunnel.
func restartTunnel() {
	cfMu.Lock()
	old := cfCmd
	cfMu.Unlock()
	if old != nil && old.Process != nil {
		old.Process.Kill()
	}
	setPublicURL("")
	go startTunnel()
}

// killChildren terminates php and cloudflared so nothing is orphaned.
func killChildren() {
	for _, c := range phpCmds {
		if c != nil && c.Process != nil {
			c.Process.Kill()
		}
	}
	if len(phpCmds) > 0 {
		logf("killed %d php worker(s)", len(phpCmds))
	}
	cfMu.Lock()
	c := cfCmd
	cfMu.Unlock()
	if c != nil && c.Process != nil {
		c.Process.Kill()
		logf("killed cloudflared")
	}
}
