<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $id = isset($_GET['id']) ? (int) $_GET['id'] : 0;
    if ($id <= 0) {
        jsonResponse(['error' => 'id is required'], 400);
        exit;
    }

    $pdo = getDb();
    $stmt = $pdo->prepare('SELECT id, status, result, thread, name, summary, final, delivered_at, outcome FROM jobs WHERE id = :id');
    $stmt->execute(['id' => $id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($row === false) {
        jsonResponse(['error' => 'job not found'], 404);
        exit;
    }

    jsonResponse([
        'id' => (int) $row['id'],
        'status' => $row['status'],
        'result' => $row['result'] !== null ? json_decode($row['result'], true) : null,
        'thread' => $row['thread'],
        'name' => $row['name'],
        'summary' => $row['summary'],
        'final' => (bool) $row['final'],
        // Durable ACK flag (note 448's ACK+RETRY layer) -- true once
        // delivery.php recorded a confirmed chat delivery for this job. The
        // extension's result-watcher (background.js) uses this, not its own
        // local storage, as the source of truth for whether a 'done' job
        // still needs (re-)delivering.
        'delivered' => $row['delivered_at'] !== null,
        'outcome' => $row['outcome'],
    ]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$input = readJsonBody();
if (!isset($input['id'], $input['result'])) {
    jsonResponse(['error' => 'id and result are required'], 400);
    exit;
}

$pdo = getDb();
$jobId = (int) $input['id'];
$now = isoNow();
$pdo->exec('BEGIN IMMEDIATE');

try {
    // COALESCE keeps the machine poll.php already recorded when the agent's
    // result POST doesn't include one, rather than clobbering it with NULL.
    $stmt = $pdo->prepare("UPDATE jobs SET result = :result, status = 'done', machine = COALESCE(:machine, machine), outcome = :outcome, updated_at = :now WHERE id = :id");
    $stmt->execute([
        'result' => json_encode($input['result']),
        'machine' => isset($input['machine']) && $input['machine'] !== '' ? (string) $input['machine'] : null,
        'outcome' => classifyJobResult($input['result']),
        'now' => $now,
        'id' => $jobId,
    ]);

    if ($stmt->rowCount() === 0) {
        $pdo->exec('COMMIT');
        jsonResponse(['error' => 'job not found'], 404);
        exit;
    }

    $jobStmt = $pdo->prepare('SELECT thread, payload, machine, target FROM jobs WHERE id = :id');
    $jobStmt->execute(['id' => $jobId]);
    $job = $jobStmt->fetch(PDO::FETCH_ASSOC);

    bumpPlanActivity($pdo, $job !== false ? $job['thread'] : null, $now);

    // Capture the CC session id the agent parsed out, keyed by thread+repo
    // (derived from the job's own payload.cwd) so a later job on the same
    // thread/repo can resume it -- and by the MACHINE that produced it (M1
    // multi-machine targeting), since a session id only ever resolves on the box
    // whose CC created it.
    if ($job !== false && isset($input['session_id']) && $input['session_id'] !== '') {
        $payload = json_decode($job['payload'], true);
        $cwd = is_array($payload) && isset($payload['cwd']) ? (string) $payload['cwd'] : '';

        if ($job['thread'] !== null && $cwd !== '') {
            $label = isset($input['session']) && $input['session'] !== '' ? (string) $input['session'] : 'default';
            // Key on the machine that actually RAN the job (jobs.machine, which
            // the UPDATE above just COALESCE'd from this POST), not its target:
            // the session file lives wherever CC really executed. They agree for
            // anything poll.php handed out post-targeting; the target and 'vm'
            // fallbacks cover a job claimed by an agent that sent no machine at
            // all, matching the 'vm' default the rest of the schema uses.
            $sessionMachine = $job['machine'] !== null && $job['machine'] !== ''
                ? (string) $job['machine']
                : ($job['target'] !== null && $job['target'] !== '' ? (string) $job['target'] : 'vm');
            $sessionStmt = $pdo->prepare(
                'INSERT INTO sessions (thread, repo, label, machine, session_id, updated_at) VALUES (:thread, :repo, :label, :machine, :session_id, :now)
                 ON CONFLICT(thread, repo, label, machine) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at'
            );
            $sessionStmt->execute([
                'thread' => $job['thread'],
                'repo' => repoFromCwd($cwd),
                'label' => $label,
                'machine' => $sessionMachine,
                'session_id' => (string) $input['session_id'],
                'now' => $now,
            ]);
        }
    }

    releaseLockAndWake($pdo, $jobId, $now);

    $pdo->exec('COMMIT');
} catch (Throwable $e) {
    $pdo->exec('ROLLBACK');
    throw $e;
}

jsonResponse(['ok' => true]);
