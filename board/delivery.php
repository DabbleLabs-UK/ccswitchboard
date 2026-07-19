<?php
declare(strict_types=1);

// Client-reported "held for delivery" flag, driving the SW menu row's and
// board row's (index.php) waiting LED. background.js's send state machine
// calls this whenever a job's wake-prompt/advice delivery enters or leaves
// its 'hold' phase (see content.css's ccsw-job-bar--waiting for the
// extension's own toolbar-pill copy of this same signal) -- this endpoint
// just records what it's told, it doesn't decide when a job is waiting.
//
// Also handles the ACK half of note 448's ACK+RETRY layer: a POST with
// `delivered: true` marks jobs.delivered_at, the durable server-side signal
// result.php's `delivered` field reports back to the extension's
// result-watcher (background.js) so it stops re-offering a job once its
// wake-prompt has actually landed in chat. Kept as a separate branch (not
// folded into the delivery_pending toggle above) since a caller can ACK a
// delivery without also touching the pending flag.
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
$pdo = getDb();

if (array_key_exists('delivered', $input) && $input['delivered']) {
    $stmt = $pdo->prepare('UPDATE jobs SET delivered_at = :now, delivery_pending = 0 WHERE id = :id');
    $stmt->execute(['now' => isoNow(), 'id' => $jobId]);

    if ($stmt->rowCount() === 0) {
        jsonResponse(['error' => 'job not found'], 404);
        exit;
    }

    jsonResponse(['ok' => true]);
    exit;
}

$pending = !empty($input['pending']) ? 1 : 0;
$stmt = $pdo->prepare('UPDATE jobs SET delivery_pending = :pending WHERE id = :id');
$stmt->execute(['pending' => $pending, 'id' => $jobId]);

if ($stmt->rowCount() === 0) {
    jsonResponse(['error' => 'job not found'], 404);
    exit;
}

jsonResponse(['ok' => true]);
