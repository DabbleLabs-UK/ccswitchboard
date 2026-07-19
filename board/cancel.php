<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

$pdo = getDb();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    // Polled by the agent every 2s while a job is running.
    $id = isset($_GET['job_id']) ? (int) $_GET['job_id'] : 0;
    if ($id <= 0) {
        jsonResponse(['error' => 'job_id is required'], 400);
        exit;
    }

    $stmt = $pdo->prepare('SELECT cancel_requested FROM jobs WHERE id = :id');
    $stmt->execute(['id' => $id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($row === false) {
        jsonResponse(['error' => 'job not found'], 404);
        exit;
    }

    jsonResponse(['cancel_requested' => (bool) $row['cancel_requested']]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$input = readJsonBody();
if (!isset($input['job_id'])) {
    jsonResponse(['error' => 'job_id is required'], 400);
    exit;
}

$jobId = (int) $input['job_id'];
$now = isoNow();
$pdo->exec('BEGIN IMMEDIATE');

try {
    $stmt = $pdo->prepare('SELECT status, thread FROM jobs WHERE id = :id');
    $stmt->execute(['id' => $jobId]);
    $job = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($job === false) {
        $pdo->exec('ROLLBACK');
        jsonResponse(['error' => 'job not found'], 404);
        exit;
    }

    if ($job['status'] === 'done') {
        $pdo->exec('ROLLBACK');
        jsonResponse(['error' => 'job already finished'], 409);
        exit;
    }

    if ($job['status'] === 'pending') {
        // Never picked up by the agent (and may never be, if the queue is
        // backed up) -- finalize it here rather than flagging it and
        // waiting for a poll cycle that has nothing to poll.
        $stmt = $pdo->prepare(
            "UPDATE jobs SET status = 'done', result = :result, cancel_requested = 1, outcome = :outcome, updated_at = :now WHERE id = :id"
        );
        $stmt->execute(['result' => json_encode('CANCELLED'), 'outcome' => 'cancelled', 'now' => $now, 'id' => $jobId]);

        releaseLockAndWake($pdo, $jobId, $now);
    } else {
        // running -- flag it; the agent's poll loop kills the process tree
        // and posts the CANCELLED result itself.
        $stmt = $pdo->prepare('UPDATE jobs SET cancel_requested = 1, updated_at = :now WHERE id = :id');
        $stmt->execute(['now' => $now, 'id' => $jobId]);
    }

    bumpPlanActivity($pdo, $job['thread'], $now);

    $pdo->exec('COMMIT');
} catch (Throwable $e) {
    $pdo->exec('ROLLBACK');
    throw $e;
}

jsonResponse(['ok' => true]);
