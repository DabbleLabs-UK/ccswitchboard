<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

// Manual Controls panel (board/index.php) -- force-releases ONE repo's lock
// by name, for a job that's stuck (crashed agent, hand-killed process) and
// will never post a result to release it itself via result.php's normal
// releaseLockAndWake path.
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$input = readJsonBody();
$repo = isset($input['repo']) ? (string) $input['repo'] : '';
if ($repo === '') {
    jsonResponse(['error' => 'repo is required'], 400);
    exit;
}

$pdo = getDb();
$now = isoNow();
$pdo->exec('BEGIN IMMEDIATE');

try {
    $released = releaseRepoLock($pdo, $repo, $now);
    $pdo->exec('COMMIT');
} catch (Throwable $e) {
    $pdo->exec('ROLLBACK');
    throw $e;
}

if (!$released) {
    jsonResponse(['error' => 'no lock held for that repo'], 404);
    exit;
}

jsonResponse(['ok' => true, 'repo' => $repo]);
