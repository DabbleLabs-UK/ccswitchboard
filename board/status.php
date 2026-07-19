<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

// Lightweight single-job status lookup for feed.php's header poll -- returns
// just the fields the status line/timer needs, never the result/output blob,
// so polling one job doesn't drag the whole board's payloads onto the main
// thread (see jobs.php for the full multi-job listing that pollHeader used
// to hit for this).
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$id = isset($_GET['id']) ? (int) $_GET['id'] : 0;
if ($id <= 0) {
    jsonResponse(['error' => 'id is required'], 400);
    exit;
}

$pdo = getDb();
reapDeadJobs($pdo);
reapStalePendingJobs($pdo);

$stmt = $pdo->prepare('SELECT id, status, thread, name, summary, updated_at, started_at, created_at, payload, outcome FROM jobs WHERE id = :id');
$stmt->execute(['id' => $id]);
$row = $stmt->fetch(PDO::FETCH_ASSOC);

if ($row === false) {
    jsonResponse(['error' => 'job not found'], 404);
    exit;
}

// Only the derived bash/CC flag is returned, not the payload itself -- this
// endpoint stays a lightweight per-job lookup (see the comment above).
$payload = json_decode($row['payload'], true);
$isCommand = is_array($payload) && isset($payload['type']) && strtolower((string) $payload['type']) === 'bash';

jsonResponse([
    'id' => (int) $row['id'],
    'status' => $row['status'],
    'thread' => $row['thread'],
    'name' => $row['name'],
    'summary' => $row['summary'],
    'updated_at' => $row['updated_at'],
    'started_at' => $row['started_at'],
    'created_at' => $row['created_at'],
    'is_command' => $isCommand,
    // NULL until the job goes terminal; one of classifyJobResult()'s
    // success/cancelled/needs_input/errored (db.php) once it is -- feed.php's
    // send-to-chat header (#51) uses this directly instead of re-deriving its
    // own classification from result text.
    'outcome' => $row['outcome'],
]);
