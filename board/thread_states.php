<?php
declare(strict_types=1);

// Per-thread state derived purely from existing job rows -- no AI, no manual
// input. See classifyJobResult() in db.php for the needs_input/errored split
// (mirrors the browser extension's own error classification).
require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$pdo = getDb();
reapDeadJobs($pdo);
reapStalePendingJobs($pdo);

const DORMANT_AFTER_SECONDS = 15 * 60;
const DEFAULT_PANEL_MAX_AGE_SECONDS = 3 * 24 * 60 * 60;

// max_age (seconds) selects the panel's age window; absent falls back to the
// 3-day default, 0 is the sentinel for "Forever" (no age filter).
$panelMaxAgeSeconds = DEFAULT_PANEL_MAX_AGE_SECONDS;
if (isset($_GET['max_age']) && ctype_digit((string) $_GET['max_age'])) {
    $panelMaxAgeSeconds = (int) $_GET['max_age'];
}

$activeThreads = array_flip($pdo->query(
    "SELECT DISTINCT thread FROM jobs WHERE thread IS NOT NULL AND thread != '' AND status IN ('pending', 'running')"
)->fetchAll(PDO::FETCH_COLUMN));

// A thread's last activity is the newest updated_at across ALL of its jobs
// (not just finished ones) -- this is what decides dormant vs idle once a
// thread isn't active and its latest finished job didn't need attention.
$lastActivity = [];
$lastActivityStmt = $pdo->query(
    "SELECT thread, MAX(updated_at) AS last_activity FROM jobs
     WHERE thread IS NOT NULL AND thread != '' GROUP BY thread"
);
foreach ($lastActivityStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
    $lastActivity[$row['thread']] = $row['last_activity'];
}

// Total job count per thread, for the Thread State chip hovercard -- all-time
// regardless of the panel's age window, since "jobs run total" is meant to be
// a lifetime stat, not scoped to what's currently displayed.
$jobCounts = [];
$jobCountStmt = $pdo->query(
    "SELECT thread, COUNT(*) AS job_count FROM jobs
     WHERE thread IS NOT NULL AND thread != '' GROUP BY thread"
);
foreach ($jobCountStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
    $jobCounts[$row['thread']] = (int) $row['job_count'];
}

// Latest job actually finished per thread, whether or not that thread is
// currently active again with something newer -- this drives the
// needs_input/errored classification below.
$latestDone = [];
$latestDoneStmt = $pdo->query(
    "SELECT jobs.thread, jobs.id, jobs.result, jobs.summary, jobs.updated_at FROM jobs
     INNER JOIN (
         SELECT thread, MAX(id) AS max_id FROM jobs
         WHERE thread IS NOT NULL AND thread != '' AND status = 'done'
         GROUP BY thread
     ) latest ON latest.thread = jobs.thread AND latest.max_id = jobs.id"
);
foreach ($latestDoneStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
    $latestDone[$row['thread']] = $row;
}

$now = time();
$stateOrder = ['active' => 0, 'needs_input' => 1, 'errored' => 2, 'dormant' => 3, 'idle' => 4];

$threads = array_map(function (string $thread) use ($activeThreads, $lastActivity, $latestDone, $jobCounts, $now) {
    $latestJob = $latestDone[$thread] ?? null;
    $activity = $lastActivity[$thread] ?? null;
    $secondsSinceActivity = $activity !== null ? $now - strtotime($activity) : PHP_INT_MAX;

    if (isset($activeThreads[$thread])) {
        $state = 'active';
    } else {
        $classification = $latestJob !== null
            ? classifyJobResult(json_decode($latestJob['result'], true))
            : null;

        if ($classification === 'needs_input') {
            $state = 'needs_input';
        } elseif ($classification === 'errored') {
            $state = 'errored';
        } elseif ($secondsSinceActivity > DORMANT_AFTER_SECONDS) {
            $state = 'dormant';
        } else {
            $state = 'idle';
        }
    }

    return [
        'thread' => $thread,
        'state' => $state,
        'last_activity' => $activity,
        'latest_job_id' => $latestJob !== null ? (int) $latestJob['id'] : null,
        'latest_summary' => $latestJob['summary'] ?? null,
        'job_count' => $jobCounts[$thread] ?? 0,
    ];
}, array_keys($lastActivity));

if ($panelMaxAgeSeconds > 0) {
    $threads = array_values(array_filter($threads, function (array $t) use ($now, $panelMaxAgeSeconds) {
        return $t['last_activity'] !== null && ($now - strtotime($t['last_activity'])) <= $panelMaxAgeSeconds;
    }));
}

usort($threads, function (array $a, array $b) use ($stateOrder) {
    $order = $stateOrder[$a['state']] <=> $stateOrder[$b['state']];
    if ($order !== 0) {
        return $order;
    }
    return strcmp($b['last_activity'] ?? '', $a['last_activity'] ?? '');
});

jsonResponse(['threads' => $threads]);
