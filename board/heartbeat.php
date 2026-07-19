<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $pdo = getDb();
    $row = $pdo->query('SELECT MAX(updated_at) AS latest FROM heartbeats')->fetch(PDO::FETCH_ASSOC);
    $latest = $row !== false ? $row['latest'] : null;
    // Same AGENT_OFFLINE_AFTER_SECONDS cutoff jobs.php's `agentOffline` field
    // and the Pushover alert use, so the board banner, the in-thread banner,
    // and the push notification all flip at the same moment.
    $online = !isAgentOffline($pdo);

    jsonResponse(['online' => $online, 'latest' => $latest]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$input = readJsonBody();
if (!isset($input['machine']) || $input['machine'] === '') {
    jsonResponse(['error' => 'machine is required'], 400);
    exit;
}

$machine = (string) $input['machine'];
$now = isoNow();

$pdo = getDb();
$stmt = $pdo->prepare(
    'INSERT INTO heartbeats (machine, updated_at) VALUES (:machine, :now)
     ON CONFLICT(machine) DO UPDATE SET updated_at = excluded.updated_at'
);
$stmt->execute(['machine' => $machine, 'now' => $now]);

// A reconnecting agent is the signal that stale jobs (queued while it was
// dark) can be dequeued again -- see resumeStaleJobs() in db.php. Scoped to
// THIS machine's own targeted jobs: this agent coming back says nothing about
// whether any other machine's agent is alive to dequeue its work.
resumeStaleJobs($pdo, $machine);

jsonResponse(['ok' => true]);
