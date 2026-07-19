<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

// Manual Controls panel (board/index.php) -- force-releases EVERY repo lock
// in one go. Same escape hatch as clear_lock.php but for a wholesale reset
// (e.g. after a hand-restarted agent left several repos locked to jobs that
// will never post a result), rather than hunting down each repo one at a
// time.
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$pdo = getDb();
$now = isoNow();
$pdo->exec('BEGIN IMMEDIATE');

try {
    $repos = $pdo->query('SELECT repo FROM locks')->fetchAll(PDO::FETCH_COLUMN);
    foreach ($repos as $repo) {
        releaseRepoLock($pdo, $repo, $now);
    }
    $pdo->exec('COMMIT');
} catch (Throwable $e) {
    $pdo->exec('ROLLBACK');
    throw $e;
}

jsonResponse(['ok' => true, 'cleared' => count($repos)]);
