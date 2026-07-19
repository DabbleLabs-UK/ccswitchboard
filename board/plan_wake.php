<?php
declare(strict_types=1);

// M3: one-shot pop-and-delete queue for plan-quiet nudges, mirroring
// wake.php's repo-free wake exactly. db.php's checkPlanQuietWakes() (called
// from jobs.php's poll) enqueues a row here when a thread's open plan has
// gone quiet; background.js's pollPlanWake() polls this and delivers the
// nudge via the same send state machine wake.php's repo-free wake uses.

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$pdo = getDb();
$pdo->exec('BEGIN IMMEDIATE');

try {
    $row = $pdo->query(
        'SELECT thread FROM plan_wakes ORDER BY requested_at ASC LIMIT 1'
    )->fetch(PDO::FETCH_ASSOC);

    if ($row === false) {
        $pdo->exec('COMMIT');
        jsonResponse(['thread' => null]);
        exit;
    }

    $stmt = $pdo->prepare('DELETE FROM plan_wakes WHERE thread = :thread');
    $stmt->execute(['thread' => $row['thread']]);
    $pdo->exec('COMMIT');
} catch (Throwable $e) {
    $pdo->exec('ROLLBACK');
    throw $e;
}

jsonResponse(['thread' => $row['thread']]);
