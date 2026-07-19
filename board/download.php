<?php
declare(strict_types=1);

// Auth'd file server for the provisioning artifacts in downloads/ -- currently
// just the agent zip the installer script pulls down.
//
// Why this exists rather than a bare static file: downloads/agent-win.zip sits
// in the web root (deploy only mirrors there), so without a gate it would be
// world-readable at a guessable URL -- the agent binaries handed to anyone who
// asks. PHP is the only thing on this host that can check a token, so the file
// is served through here and downloads/.htaccess denies direct access to the
// directory. Belt and braces: either alone would do, but the .htaccess is one
// line and covers the case where this file is bypassed entirely.
//
// requireAuth(), not requirePrimaryAuth(): the caller here is the INSTALLER
// running on a new box, holding that machine's own minted token. Gating this on
// the primary would mean baking the primary token into every installer, which
// is the exact thing per-machine tokens exist to avoid.

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

// Allowlist, not a path. ?file= is caller-controlled, so anything resembling
// path-joining here is a traversal bug waiting to happen (../../private/
// auth.config.php would hand over every token on the relay). Mapping a fixed
// set of names to fixed paths makes that structurally impossible rather than
// merely filtered-against.
const DOWNLOADABLE = [
    'agent-win.zip' => ['path' => __DIR__ . '/downloads/agent-win.zip', 'type' => 'application/zip'],
];

$file = (string) ($_GET['file'] ?? 'agent-win.zip');
if (!isset(DOWNLOADABLE[$file])) {
    jsonResponse(['error' => 'not found'], 404);
    exit;
}

$path = DOWNLOADABLE[$file]['path'];
if (!is_file($path)) {
    // Deployed the PHP but not the zip -- worth saying plainly, since the
    // installer surfaces this message to whoever is provisioning the box.
    jsonResponse(['error' => 'artifact not present on relay: ' . $file], 404);
    exit;
}

// noCacheHeaders() for the same ea-nginx reason as every other endpoint: the
// account's reverse-proxy cache is permanent, and a cached hit never reaches
// PHP -- so a cached copy of this response would be served to callers whose
// token was never checked, silently un-gating the zip the moment it is first
// fetched. The Set-Cookie inside is what actually stops nginx caching it.
noCacheHeaders(200);
header('Content-Type: ' . DOWNLOADABLE[$file]['type']);
header('Content-Disposition: attachment; filename="' . $file . '"');
header('Content-Length: ' . filesize($path));
header('X-Content-Type-Options: nosniff');

readfile($path);
