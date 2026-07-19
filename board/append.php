<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$input = readJsonBody();
if (!isset($input['job_id'], $input['text'])) {
    jsonResponse(['error' => 'job_id and text are required'], 400);
    exit;
}

$jobId = (int) $input['job_id'];
$text = (string) $input['text'];
$now = isoNow();

$pdo = getDb();
$pdo->exec('BEGIN IMMEDIATE');

try {
    $seqStmt = $pdo->prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM job_output WHERE job_id = :job_id');
    $seqStmt->execute(['job_id' => $jobId]);
    $seq = (int) $seqStmt->fetch(PDO::FETCH_ASSOC)['next_seq'];

    $stmt = $pdo->prepare('INSERT INTO job_output (job_id, seq, text, at) VALUES (:job_id, :seq, :text, :now)');
    $stmt->execute([
        'job_id' => $jobId,
        'seq' => $seq,
        'text' => $text,
        'now' => $now,
    ]);

    // Streaming output is the liveness signal reapWedgedJobs() (db.php) keys
    // off of -- without this, jobs.updated_at freezes at the pending->running
    // flip and a running-but-wedged job (agent alive, worker hung) never
    // trips the relay's per-job silence backstop.
    $touchStmt = $pdo->prepare("UPDATE jobs SET updated_at = :now WHERE id = :job_id AND status = 'running'");
    $touchStmt->execute(['now' => $now, 'job_id' => $jobId]);

    $pdo->exec('COMMIT');
} catch (Throwable $e) {
    $pdo->exec('ROLLBACK');
    throw $e;
}

jsonResponse(['ok' => true, 'seq' => $seq]);
