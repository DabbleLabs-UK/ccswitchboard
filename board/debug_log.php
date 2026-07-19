<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

// Diagnostic channel for CC to inspect extension/relay behaviour without a
// human relaying console logs by hand. POST {tag, data} appends a
// timestamped JSON line to debug.log in the private dir -- outside the web
// root, same as auth.log (see auth.php's logAuthEvent) -- so it survives
// redeploys. GET tails it back as plain text for curl.
function debugLogPath(): string
{
    return privateDir() . '/debug.log';
}

const DEBUG_LOG_DEFAULT_LINES = 200;
const DEBUG_LOG_MAX_LINES = 5000;

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $n = isset($_GET['n']) ? (int) $_GET['n'] : DEBUG_LOG_DEFAULT_LINES;
    $n = max(1, min(DEBUG_LOG_MAX_LINES, $n));

    $path = debugLogPath();
    $lines = is_file($path) ? file($path, FILE_IGNORE_NEW_LINES) : [];
    $tail = array_slice($lines, -$n);

    noCacheHeaders(200);
    header('Content-Type: text/plain; charset=utf-8');
    echo implode("\n", $tail) . ($tail !== [] ? "\n" : '');
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$input = readJsonBody();
if (!isset($input['tag']) || $input['tag'] === '') {
    jsonResponse(['error' => 'tag is required'], 400);
    exit;
}

$line = json_encode([
    'at' => isoNow(),
    'tag' => (string) $input['tag'],
    'data' => $input['data'] ?? null,
]);

@file_put_contents(debugLogPath(), $line . "\n", FILE_APPEND | LOCK_EX);

jsonResponse(['ok' => true]);
