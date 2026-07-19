<?php
declare(strict_types=1);

// Manual counterpart to heartbeat.php's auto-resume: flips a 'stale' job
// (one that waited too long for a worker and either has no agent back yet,
// or waited past the auto-resume cutoff) back to 'pending' so the next
// poll.php GET can dequeue it. Drives the board/pill "Resume" button.
require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

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

$pdo = getDb();
$stmt = $pdo->prepare(
    "UPDATE jobs SET status = 'pending', updated_at = :now WHERE id = :id AND status = 'stale'"
);
$stmt->execute(['now' => $now, 'id' => $jobId]);

if ($stmt->rowCount() === 0) {
    jsonResponse(['error' => 'job not found or not stale'], 404);
    exit;
}

jsonResponse(['ok' => true]);
