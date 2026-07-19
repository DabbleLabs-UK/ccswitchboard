<?php
declare(strict_types=1);

// Deploy the ccswitchboard M1 relay to production.
//
// Modelled on RedditWatch's deploy.php: FTPS via WinSCP.com, dry-run by
// default, --push to execute, retry/backoff for this host's flaky FTPS
// control channel. Unlike RedditWatch, M1 is a plain-PHP, no-dependency
// relay with no cron job and no build step, so there is no SSH section --
// one FTPS mirror ships the four web files (job.php, poll.php, result.php,
// db.php) plus .htaccess. The SQLite store lives OUTSIDE the web root at
// /home/dabblela/private/ccswitchboard/data/jobs.sqlite; db.php creates it
// (and the directory) lazily on first request via getenv('CCSW_DB_PATH'),
// which .htaccess sets via SetEnv -- open_basedir is unrestricted, so no
// remote mkdir/provisioning step is needed here.
//
// Usage:
//   php deploy.php            - dry-run (default): build dist/, print the
//                              plan (file list). Transfers NOTHING.
//   php deploy.php --push     - full deploy: FTPS-mirror dist/ -> the
//                              remote_path in deploy.config.json.
//   php deploy.php --push <files...>
//                            - targeted put of specific repo-relative files
//                              (quick single-file fix).

$push = in_array('--push', $argv ?? [], true);
$mode = $push ? 'PUSH' : 'DRY-RUN';

// Any non-flag argument is a specific repo-relative file to `put` directly
// instead of a full-tree mirror -- useful for this host's flaky FTPS control
// connection (a targeted put issues no remote LIST, so it gets through where
// a mirror can't).
$putFiles = array_values(array_filter(
    array_slice($argv ?? [], 1),
    fn($a) => $a !== '' && $a[0] !== '-'
));
$fullDeploy = $putFiles === []; // no explicit files = full mirror

$root = __DIR__;
$distDir = $root . '/dist';
$configFile = $root . '/deploy.config.json';

if (!file_exists($configFile)) {
    fwrite(STDERR, "ERROR: deploy.config.json not found. Copy deploy.config.example.json and fill in values.\n");
    exit(1);
}

$config = json_decode(file_get_contents($configFile), true);
if (!is_array($config) || empty($config['transfer'])) {
    fwrite(STDERR, "ERROR: deploy.config.json missing or malformed 'transfer' section.\n");
    exit(1);
}

$t = $config['transfer'];
foreach (['protocol', 'host', 'port', 'user', 'password', 'remote_path'] as $key) {
    if (empty($t[$key]) && $t[$key] !== 0) {
        fwrite(STDERR, "ERROR: deploy.config.json missing transfer.{$key}\n");
        exit(1);
    }
}
$tlsFingerprint = $t['tls_fingerprint'] ?? '';

if (!in_array($t['protocol'], ['sftp', 'ftps', 'ftp'], true)) {
    fwrite(STDERR, "ERROR: transfer.protocol must be sftp, ftps, or ftp. Got: {$t['protocol']}\n");
    exit(1);
}

$winscp = 'C:\\Program Files (x86)\\WinSCP\\WinSCP.com';
if (!file_exists($winscp)) {
    fwrite(STDERR, "ERROR: WinSCP.com not found at {$winscp}\n");
    exit(1);
}

// Things to omit when building dist/. Matches basename against each pattern
// (trailing / restricts to directories). Globs supported via fnmatch.
// NOTE: data/ is local-only test state -- the live SQLite store is created
// server-side by db.php, outside the web root, and is never shipped.
$buildExcludes = [
    '.git/',
    '.gitignore',
    '.claude/',
    'deploy.*',          // deploy.php, deploy.config.json, deploy.config.example.json, deploy.log, deploy.winscp.log
    '*.md',              // README.md etc -- local docs, not app content
    'data/',             // local SQLite test store -- never shipped
    'dist/',             // the build's own output dir -- must not copy into itself
    '_accordion_shots/', // local layout-verification screenshots -- never shipped
];

function isExcluded(string $name, bool $isDir, array $patterns): bool {
    foreach ($patterns as $pattern) {
        $patternIsDir = substr($pattern, -1) === '/';
        if ($patternIsDir && !$isDir) continue;
        $needle = rtrim($pattern, '/');
        if (fnmatch($needle, $name)) return true;
    }
    return false;
}

function rrmdir(string $dir): void {
    if (!is_dir($dir)) return;
    foreach (scandir($dir) as $item) {
        if ($item === '.' || $item === '..') continue;
        $path = $dir . '/' . $item;
        if (is_link($path) || is_file($path)) unlink($path);
        else rrmdir($path);
    }
    rmdir($dir);
}

function copyTree(string $src, string $dst, array $excludes): void {
    if (!is_dir($dst)) mkdir($dst, 0777, true);
    foreach (scandir($src) as $item) {
        if ($item === '.' || $item === '..') continue;
        // Skip filesystem junk (illegal-in-Windows names / PUA substitutes).
        if (strpbrk($item, ':*?"<>|') !== false) continue;
        if (preg_match('/[\x{E000}-\x{F8FF}]/u', $item)) continue;
        $srcPath = $src . '/' . $item;
        $dstPath = $dst . '/' . $item;
        $isDir = is_dir($srcPath);
        if (isExcluded($item, $isDir, $excludes)) continue;
        if ($isDir) {
            copyTree($srcPath, $dstPath, $excludes);
        } else {
            copy($srcPath, $dstPath);
            $mtime = @filemtime($srcPath);
            if ($mtime !== false) @touch($dstPath, $mtime);
        }
    }
}

/** @return list<string> dist-relative forward-slash paths, sorted. */
function enumerateFiles(string $dir, string $prefix = ''): array {
    $out = [];
    foreach (scandir($dir) as $item) {
        if ($item === '.' || $item === '..') continue;
        $path = $dir . '/' . $item;
        $rel = $prefix === '' ? $item : $prefix . '/' . $item;
        if (is_dir($path)) {
            $out = array_merge($out, enumerateFiles($path, $rel));
        } else {
            $out[] = $rel;
        }
    }
    sort($out);
    return $out;
}

function dlog(string $logFile, string $msg): void {
    $line = '[' . date('Y-m-d H:i:s') . '] ' . $msg;
    echo $line . "\n";
    @file_put_contents($logFile, $line . "\n", FILE_APPEND);
}

function sweepWinscp(): void {
    @exec('taskkill /F /IM WinSCP.com /T 2>&1');
    @exec('taskkill /F /IM WinSCP.exe /T 2>&1');
}

// Run one child process with a hard wall-clock timeout, streaming stdout+stderr
// to the console and appending to $logFile. Returns [exitCode, timedOut, capturedOutput].
function runProc(string $cmd, string $logFile, int $timeoutSec): array {
    $descriptors = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $proc = proc_open($cmd, $descriptors, $pipes);
    if (!is_resource($proc)) {
        dlog($logFile, 'ERROR: failed to start process.');
        return [1, false, ''];
    }
    fclose($pipes[0]);
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);

    $start = time();
    $timedOut = false;
    $exitCode = 1;
    $captured = '';

    while (true) {
        $status = proc_get_status($proc);
        foreach ([1, 2] as $i) {
            $chunk = fread($pipes[$i], 8192);
            if ($chunk !== '' && $chunk !== false) {
                echo $chunk;
                $captured .= $chunk;
                @file_put_contents($logFile, $chunk, FILE_APPEND);
            }
        }
        if (!$status['running']) {
            foreach ([1, 2] as $i) {
                while (($chunk = fread($pipes[$i], 8192)) !== '' && $chunk !== false) {
                    echo $chunk;
                    $captured .= $chunk;
                    @file_put_contents($logFile, $chunk, FILE_APPEND);
                }
            }
            $exitCode = $status['exitcode'];
            break;
        }
        if ((time() - $start) >= $timeoutSec) {
            $timedOut = true;
            dlog($logFile, "TIMEOUT: exceeded {$timeoutSec}s; killing pid {$status['pid']}.");
            @exec('taskkill /F /T /PID ' . (int)$status['pid'] . ' 2>&1');
            proc_terminate($proc);
            $exitCode = 1;
            break;
        }
        usleep(200000);
    }
    foreach ($pipes as $p) if (is_resource($p)) fclose($p);
    proc_close($proc);
    return [$exitCode, $timedOut, $captured];
}

$logFile   = $root . '/deploy.log';
$winscpLog = $root . '/deploy.winscp.log';

// --- Step 1: build dist/ ---------------------------------------------------
echo "=== ccswitchboard deploy {$mode} ===\n";
echo "Step 1: building dist/ from project root...\n";
rrmdir($distDir);
copyTree($root, $distDir, $buildExcludes);
$distFiles = enumerateFiles($distDir);
echo "dist/ built (" . count($distFiles) . " files).\n\n";

// --- DRY-RUN: print the plan, connect to nothing ---------------------------
if (!$push) {
    echo "Planned FTPS mirror -> {$t['protocol']}://{$t['user']}@{$t['host']}:{$t['port']}{$t['remote_path']}\n\n";

    echo "Files in dist/ (a full --push mirrors these):\n";
    foreach ($distFiles as $f) {
        echo "  {$f}\n";
    }

    echo "\nServer-side (NOT shipped): the SQLite store at\n";
    echo "/home/dabblela/private/ccswitchboard/data/jobs.sqlite is created lazily\n";
    echo "by db.php on first request (open_basedir is unrestricted) -- no\n";
    echo "provisioning step needed.\n";

    echo "\nDRY-RUN complete. No files transferred. Run with --push to deploy.\n";
    exit(0);
}

// --- PUSH -------------------------------------------------------------------
$url = sprintf('%s://%s@%s:%d/', $t['protocol'], rawurlencode($t['user']), $t['host'], (int)$t['port']);
$password   = $t['password'];
$remotePath = rtrim($t['remote_path'], '/');
$localPath  = str_replace('/', '\\', $distDir);

$header = <<<HEAD
option batch abort
option confirm off
option transfer binary
option reconnecttime 10
open {$url} -password="{$password}" -explicit -certificate="{$tlsFingerprint}" -rawsettings MinTlsVersion=2 FtpSecure=1 FtpPingType=1 FtpPingInterval=15 Timeout=120
HEAD;

dlog($logFile, "=== Deploy {$mode} started (" . ($fullDeploy ? 'full mirror' : 'targeted put ' . count($putFiles) . ' file(s)') . ") ===");

// Runs a WinSCP script (built by caller) with retry/backoff.
$runWinscpScript = function (string $script, string $label, int $perAttemptTimeout = 300) use ($winscp, $winscpLog, $logFile): bool {
    $scriptFile = tempnam(sys_get_temp_dir(), 'wscp_') . '.txt';
    file_put_contents($scriptFile, $script);
    $cmd = sprintf('"%s" /log="%s" /loglevel=0 /script="%s"', $winscp, $winscpLog, $scriptFile);
    $maxAttempts = 6;
    $ok = false;
    try {
        for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
            dlog($logFile, "--- {$label}: attempt {$attempt}/{$maxAttempts} ---");
            sweepWinscp();
            [$exitCode, $timedOut] = runProc($cmd, $logFile, $perAttemptTimeout);
            if ($exitCode === 0 && !$timedOut) {
                dlog($logFile, "{$label}: attempt {$attempt} succeeded.");
                $ok = true;
                break;
            }
            $why = $timedOut ? "timed out after {$perAttemptTimeout}s" : "WinSCP exit {$exitCode}";
            dlog($logFile, "{$label}: attempt {$attempt} failed ({$why}).");
            if ($attempt < $maxAttempts) {
                $backoff = (int) min(20 * (2 ** ($attempt - 1)), 120);
                dlog($logFile, "Backing off {$backoff}s...");
                sleep($backoff);
            }
        }
    } finally {
        @unlink($scriptFile);
        sweepWinscp();
    }
    return $ok;
};

echo "Target: {$t['protocol']}://{$t['user']}@{$t['host']}:{$t['port']}{$remotePath}\n";
echo "Local:  {$localPath}\n\n";

// --- Targeted put: just the named files -------------------------------------
if (!$fullDeploy) {
    $lines = [$header];
    $remoteDirs = [];
    foreach ($putFiles as $rel) {
        $rel = str_replace('\\', '/', ltrim($rel, '/'));
        $localFile = $localPath . '\\' . str_replace('/', '\\', $rel);
        if (!is_file($localFile)) {
            fwrite(STDERR, "ERROR: file not found in dist/: {$rel} (excluded from build, or mistyped?)\n");
            exit(1);
        }
        $remoteFile = $remotePath . '/' . $rel;
        // A put into a remote SUBDIR that doesn't exist yet just fails ("no
        // such directory") -- which is what shipping the first file of a new
        // dir (downloads/) does. Collect the parents so they can be created
        // first; only the full mirror created dirs before this.
        $relDir = str_replace('\\', '/', dirname($rel));
        if ($relDir !== '' && $relDir !== '.') {
            $remoteDirs[$remotePath . '/' . $relDir] = true;
        }
        echo "  put {$rel} -> {$remoteFile}\n";
        dlog($logFile, "Queued put: {$rel} -> {$remoteFile}");
        $lines[] = sprintf('put -nopermissions "%s" "%s"', $localFile, $remoteFile);
    }

    // Same tolerant best-effort mkdir the full deploy does for remotePath (see
    // Step 2 below): its own "batch continue" script, so the "already exists"
    // failure on every redeploy after the first doesn't abort the put.
    if ($remoteDirs !== []) {
        $mkdirLines = [str_replace('option batch abort', 'option batch continue', $header)];
        foreach (array_keys($remoteDirs) as $dir) {
            echo "  mkdir (if needed) {$dir}\n";
            $mkdirLines[] = sprintf('mkdir "%s"', $dir);
        }
        $mkdirLines[] = 'close';
        $mkdirLines[] = 'exit';
        $runWinscpScript(implode("\n", $mkdirLines) . "\n", 'mkdir remote subdirs', 60);
    }
    $lines[] = 'close';
    $lines[] = 'exit';
    if (!$runWinscpScript(implode("\n", $lines) . "\n", 'targeted put')) {
        fwrite(STDERR, "\nTargeted put failed. See {$logFile}\n");
        exit(1);
    }
    dlog($logFile, "=== Targeted put complete. ===");
    echo "\nTargeted put complete.\n";
    exit(0);
}

// --- Full deploy: ensure the remote dir exists, then FTPS mirror -----------
// A fresh box has no public_html/ccswitchboard/board yet, and WinSCP's `cd` errors
// on a missing directory. Best-effort mkdir first, in its own "batch continue"
// script so an "already exists" failure on redeploys doesn't abort anything
// (WinSCP's `-command` ignore-error prefix isn't recognized in this console
// script mode, so this is done as a separate tolerant script instead).
echo "\nStep 2: ensuring remote directory exists...\n";
$mkdirHeader = str_replace('option batch abort', 'option batch continue', $header);
$mkdirScript = $mkdirHeader . "\n" . <<<SCRIPT
mkdir "{$remotePath}"
close
exit
SCRIPT;
$runWinscpScript($mkdirScript, 'mkdir remote dir', 60);

echo "\nStep 3: FTPS mirror...\n";
$mirrorScript = $header . "\n" . <<<SCRIPT
lcd "{$localPath}"
cd "{$remotePath}"
synchronize remote -delete -mirror -criteria=time
close
exit
SCRIPT;
if (!$runWinscpScript($mirrorScript, 'mirror')) {
    fwrite(STDERR, "\nMirror failed. See {$logFile}\n");
    exit(1);
}

dlog($logFile, "=== PUSH complete: code mirrored to {$remotePath}. ===");
echo "\nPUSH complete. Code shipped to {$remotePath}.\n";
exit(0);
