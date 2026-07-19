<?php
declare(strict_types=1);

// Serves install-ccsw-<machine>.ps1: installer-template.ps1 with that
// machine's relay base, token and name baked in. Downloaded from machines.php,
// run once on the new box.
//
// The rendered file is a SECRET -- it carries the machine's token in clear
// text. That drives the two rules here: primary-token-only access (a machine
// must not be able to fetch a peer's installer, and so its token), and
// aggressively uncacheable responses (see below).

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requirePrimaryAuth();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$machine = (string) ($_GET['machine'] ?? '');
if (!isValidMachineName($machine)) {
    jsonResponse(['error' => 'invalid machine name'], 400);
    exit;
}

$stmt = getDb()->prepare('SELECT machine, token FROM machines WHERE machine = :machine');
$stmt->execute(['machine' => $machine]);
$row = $stmt->fetch(PDO::FETCH_ASSOC);
if ($row === false) {
    jsonResponse(['error' => 'unknown machine'], 404);
    exit;
}

$template = @file_get_contents(__DIR__ . '/installer-template.ps1');
if ($template === false) {
    jsonResponse(['error' => 'installer template missing on relay'], 500);
    exit;
}

// Relay base derived from the request rather than hard-coded, so the same code
// renders a working installer from local dev and from prod without a config
// switch. HTTP_HOST is client-controlled in principle -- but this endpoint is
// behind the primary token, so the only person who could poison it is the one
// person already holding full access, and the blast radius is an installer
// pointing at their own wrong hostname.
$scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$host = (string) ($_SERVER['HTTP_HOST'] ?? 'dabblelabs.uk');
$dir = rtrim(str_replace('\\', '/', dirname((string) ($_SERVER['SCRIPT_NAME'] ?? '/'))), '/');
$relayBase = $scheme . '://' . $host . $dir;

// Single-quoted PowerShell strings escape a quote by doubling it. Both values
// are already constrained at the point they are minted (name to
// [A-Za-z0-9_-]{1,32}, token to 64 hex chars), so nothing here can contain a
// quote today -- this is defence in depth against a future caller that mints
// less strictly, not a live fix.
$psQuote = fn(string $v): string => str_replace("'", "''", $v);

$script = strtr($template, [
    '{{RELAY_BASE}}' => $psQuote($relayBase),
    '{{TOKEN}}' => $psQuote((string) $row['token']),
    '{{MACHINE}}' => $psQuote((string) $row['machine']),
]);

// Hard no-cache is load-bearing, not hygiene. Every machine's installer is the
// same URL bar a query string, and a cached response here would hand machine B
// the script -- and therefore the TOKEN -- minted for machine A. noCacheHeaders()
// is the same helper the JSON endpoints use, and its Set-Cookie is what
// actually stops the account's ea-nginx cache (permanent by default, never
// re-consults PHP on a hit) from storing this. private/no-store repeated
// explicitly for any intermediary that ignores the cookie rule.
noCacheHeaders(200);
header('Cache-Control: private, no-store, no-cache, must-revalidate, max-age=0');
header('Content-Type: text/plain; charset=utf-8');
header('Content-Disposition: attachment; filename="install-ccsw-' . $machine . '.ps1"');
header('Content-Length: ' . strlen($script));
header('X-Content-Type-Options: nosniff');

// Deliberately NOT logged, here or in machines.php: the whole point of the
// endpoint is a value that must not end up in a log file.
echo $script;
