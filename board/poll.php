<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$machine = isset($_GET['machine']) && $_GET['machine'] !== '' ? (string) $_GET['machine'] : null;

// M1 multi-machine targeting: an agent is only ever handed jobs dispatched FOR
// it (jobs.target, set by job.php from payload.machine). An agent that polls
// without a ?machine= is treated as the VM -- the same default job.php stamps
// on every untargeted dispatch -- so a pre-targeting agent build keeps getting
// exactly the jobs it always did, and a DELL-targeted job is never handed to it.
$target = $machine ?? 'vm';

$pdo = getDb();
runThrottledReapSweeps($pdo);

$pdo->exec('BEGIN IMMEDIATE');

try {
    $selectStmt = $pdo->prepare(
        "SELECT id, payload, thread, continue FROM jobs WHERE status = 'pending' AND target = :target ORDER BY id ASC LIMIT 1"
    );
    $selectStmt->execute(['target' => $target]);
    $row = $selectStmt->fetch(PDO::FETCH_ASSOC);

    if ($row === false) {
        $pdo->exec('COMMIT');
        jsonResponse(['job' => null]);
        exit;
    }

    $stmt = $pdo->prepare("UPDATE jobs SET status = 'running', machine = :machine, started_at = :now, updated_at = :now WHERE id = :id");
    $stmt->execute(['machine' => $machine, 'now' => isoNow(), 'id' => $row['id']]);
    $pdo->exec('COMMIT');
} catch (Throwable $e) {
    $pdo->exec('ROLLBACK');
    throw $e;
}

jsonResponse([
    'id' => (int) $row['id'],
    'payload' => json_decode($row['payload'], true),
    'thread' => $row['thread'],
    'continue' => (bool) $row['continue'],
]);
