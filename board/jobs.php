<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$status = $_GET['status'] ?? 'done';
if (!in_array($status, ['pending', 'running', 'stale', 'done', 'all'], true)) {
    jsonResponse(['error' => 'status must be pending, running, stale, done, or all'], 400);
    exit;
}

$limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 50;
$limit = max(1, min($limit, 500));

// max_age (seconds) mirrors thread_states.php's panel window -- the board's
// activity-window chips filter this list the same way they filter the
// Thread State chips, so both stay in sync. Absent means no age filter; 0 is
// the sentinel for "Forever" (also no filter, real 0-second filter would
// exclude everything).
$maxAgeSeconds = null;
if (isset($_GET['max_age']) && ctype_digit((string) $_GET['max_age'])) {
    $maxAgeSeconds = (int) $_GET['max_age'];
}
$cutoff = $maxAgeSeconds !== null && $maxAgeSeconds > 0
    ? gmdate('Y-m-d\TH:i:s\Z', time() - $maxAgeSeconds)
    : null;

// Bug A ledger audit: `?undelivered=1` restricts the list to jobs that are
// done-but-never-confirmed-delivered (status = 'done' AND delivered_at IS
// NULL) -- i.e. a finished job whose result never landed in chat. Additive
// and backward compatible: absent/0 = no filter, existing callers unchanged.
$undelivered = isset($_GET['undelivered']) && $_GET['undelivered'] !== '' && $_GET['undelivered'] !== '0';

$pdo = getDb();
reapDeadJobs($pdo);
reapWedgedJobs($pdo);
reapOrphanedLocks($pdo);
reapStalePendingJobs($pdo);
checkPlanQuietWakes($pdo);
checkAgentOfflineAlert($pdo);

// Column list shared by both branches -- delivered_at and nudged_at are
// exposed here (Bug A) so a done-but-undelivered job can be audited: NULL
// delivered_at means "the extension never confirmed this reached chat", and
// nudged_at shows whether the relay's own undelivered-results sweep has
// already prodded the thread about it.
// target/machine (M1 multi-machine targeting) are the dispatch-time request and
// the claim-time answer respectively -- the board shows both, since "queued for
// DELL" and "actually ran on DELL" are different facts, and a job pending
// against a target whose agent has never appeared is only diagnosable if the
// target is visible.
$cols = 'id, status, result, thread, payload, name, summary, final, continue, delivery_pending, updated_at, outcome, delivered_at, nudged_at, target, machine';

if ($status === 'all') {
    $conds = [];
    if ($cutoff !== null) {
        $conds[] = 'updated_at >= :cutoff';
    }
    // undelivered without an explicit status still means "done but not
    // delivered" -- pin status so `?undelivered=1` alone is meaningful.
    if ($undelivered) {
        $conds[] = "status = 'done' AND delivered_at IS NULL";
    }
    $where = $conds !== [] ? 'WHERE ' . implode(' AND ', $conds) : '';
    $stmt = $pdo->prepare(
        "SELECT {$cols} FROM
            (SELECT {$cols} FROM jobs {$where} ORDER BY id DESC LIMIT {$limit})
         ORDER BY id ASC"
    );
    $stmt->execute($cutoff !== null ? ['cutoff' => $cutoff] : []);
} else {
    $conds = ['status = :status'];
    $params = ['status' => $status];
    if ($cutoff !== null) {
        $conds[] = 'updated_at >= :cutoff';
        $params['cutoff'] = $cutoff;
    }
    if ($undelivered) {
        $conds[] = 'delivered_at IS NULL';
    }
    $where = 'WHERE ' . implode(' AND ', $conds);
    $stmt = $pdo->prepare(
        "SELECT {$cols} FROM
            (SELECT {$cols} FROM jobs {$where} ORDER BY id DESC LIMIT {$limit})
         ORDER BY id ASC"
    );
    $stmt->execute($params);
}
$rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

$jobs = array_map(function ($row) {
    $payload = json_decode($row['payload'], true);
    $cwd = is_array($payload) && isset($payload['cwd']) ? (string) $payload['cwd'] : '';
    $model = is_array($payload) && isset($payload['model']) && $payload['model'] !== '' ? (string) $payload['model'] : null;
    // Bash jobs carry a command instead of a prompt (see job.php's isBash check) --
    // fall back to it so "full prompt" still means "the instruction the agent ran".
    $prompt = is_array($payload) && isset($payload['prompt']) && $payload['prompt'] !== ''
        ? (string) $payload['prompt']
        : (is_array($payload) && isset($payload['command']) && $payload['command'] !== '' ? (string) $payload['command'] : null);
    // Mirrors job.php's isBash check -- lets the board/hovercards/toolbar
    // distinguish a raw shell command from a CC prompt.
    $isCommand = is_array($payload) && isset($payload['type']) && strtolower((string) $payload['type']) === 'bash';

    // Mirrors AgentCore.cs's _silenceTimeout default -- keep in sync if that changes.
    $silenceTimeout = is_array($payload) && isset($payload['silence_timeout']) && $payload['silence_timeout'] > 0
        ? (float) $payload['silence_timeout']
        : 90.0;

    // Mirrors AgentCore.cs's sessionLabel default -- keep in sync if that changes.
    $session = is_array($payload) && isset($payload['session']) && $payload['session'] !== ''
        ? (string) $payload['session']
        : 'default';

    $result = $row['result'] !== null ? json_decode($row['result'], true) : null;

    return [
        'id' => (int) $row['id'],
        'status' => $row['status'],
        'result' => $result,
        'result_stats' => parseResultEnvelope($result),
        'thread' => $row['thread'],
        'repo' => $cwd !== '' ? repoFromCwd($cwd) : null,
        'name' => $row['name'],
        'summary' => $row['summary'],
        'model' => $model,
        'prompt' => $prompt,
        'silence_timeout' => $silenceTimeout,
        'continue' => (bool) $row['continue'],
        'session' => $session,
        'is_command' => $isCommand,
        'final' => (bool) $row['final'],
        'delivery_pending' => (bool) $row['delivery_pending'],
        'updated_at' => $row['updated_at'],
        'outcome' => $row['outcome'],
        // Bug A ledger: NULL delivered_at on a 'done' job == a result that
        // never reached chat (a silent output loss). nudged_at shows whether
        // the relay's undelivered-results sweep has already prodded about it.
        'delivered_at' => $row['delivered_at'],
        'nudged_at' => $row['nudged_at'],
        // The machine this job was dispatched FOR vs. the one that actually
        // claimed it -- machine stays null until an agent picks it up.
        'target' => $row['target'],
        'machine' => $row['machine'],
    ];
}, $rows);

jsonResponse(['jobs' => $jobs, 'agentOffline' => isAgentOffline($pdo)]);
