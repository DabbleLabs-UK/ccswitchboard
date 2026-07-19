<?php
declare(strict_types=1);

// Batch-records relay (#50): clusters the permanent jobs table into
// per-thread "batches" -- runs of consecutive jobs on the same thread with
// no big gap between one job finishing (updated_at) and the next starting
// (created_at). Two shapes:
//   GET stats.php                 -> batch summaries + all-time records
//   GET stats.php?batch=<key>     -> one batch's job list (capped)
// Never selects the `result` column (the heavy blob) -- outcome is already
// classified into that column by db.php, so no result parsing is needed here.
require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

const DEFAULT_GAP_MINUTES = 15;
const MAX_BATCH_DETAIL_JOBS = 20;

// ?gap= is in MINUTES (matches the "15min" the threshold is specced in),
// unlike this codebase's other age-window params (max_age etc.) which are
// seconds -- documented here since it's the odd one out.
$gapMinutes = DEFAULT_GAP_MINUTES;
if (isset($_GET['gap']) && ctype_digit((string) $_GET['gap'])) {
    $gapMinutes = max(1, min((int) $_GET['gap'], 24 * 60));
}
$gapSeconds = $gapMinutes * 60;

$limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 50;
$limit = max(1, min($limit, 500));

$pdo = getDb();

// Clusters an already thread+id-ordered row set into batches. Each batch
// carries its own capped job list (public detail endpoint slices it further)
// so both the full-listing and single-batch code paths share one pass.
function clusterJobsIntoBatches(array $rows, int $gapSeconds): array
{
    $batches = [];
    $current = null;
    $prevThread = null;
    $prevUpdatedAt = null;

    foreach ($rows as $row) {
        $thread = $row['thread'];
        $createdAt = $row['created_at'];
        $gapFromPrev = $prevThread === $thread && $prevUpdatedAt !== null
            ? strtotime($createdAt) - strtotime($prevUpdatedAt)
            : null;

        $startsNewBatch = $current === null || $thread !== $prevThread || $gapFromPrev >= $gapSeconds;

        if ($startsNewBatch) {
            if ($current !== null) {
                $batches[] = $current;
            }
            $current = ['thread' => $thread, 'jobs' => []];
        }

        $payload = json_decode($row['payload'], true);
        $isCommand = is_array($payload) && isset($payload['type']) && strtolower((string) $payload['type']) === 'bash';
        $model = is_array($payload) && isset($payload['model']) && $payload['model'] !== '' ? (string) $payload['model'] : null;

        $current['jobs'][] = [
            'id' => (int) $row['id'],
            'name' => $row['name'],
            'is_command' => $isCommand,
            'model' => $model,
            'created_at' => $createdAt,
            'updated_at' => $row['updated_at'],
            // updated_at - created_at, same field pair the clustering gap
            // itself uses. For a still-running/pending job this is queue-wait
            // or in-flight elapsed time rather than a true finished runtime --
            // an accepted approximation (mirrors the running-section timer,
            // which treats updated_at the same way).
            'duration_seconds' => max(0, strtotime($row['updated_at']) - strtotime($createdAt)),
            'outcome' => $row['outcome'],
        ];

        $prevThread = $thread;
        $prevUpdatedAt = $row['updated_at'];
    }
    if ($current !== null) {
        $batches[] = $current;
    }

    return $batches;
}

// Reduces one cluster (thread + ordered job list) down to the summary shape
// the batch table/records strip use -- never carries the per-job list.
function summarizeBatch(array $batch): array
{
    $jobs = $batch['jobs'];
    $startedAt = $jobs[0]['created_at'];
    $endedAt = $jobs[count($jobs) - 1]['updated_at'];

    $ccJobs = 0;
    $commandJobs = 0;
    $succeeded = 0;
    $errored = 0;
    $longest = null;
    foreach ($jobs as $job) {
        if ($job['is_command']) {
            $commandJobs++;
        } else {
            $ccJobs++;
        }
        if ($job['outcome'] === 'success') {
            $succeeded++;
        } elseif ($job['outcome'] === 'errored') {
            $errored++;
        }
        if ($longest === null || $job['duration_seconds'] > $longest['duration_seconds']) {
            $longest = $job;
        }
    }

    return [
        // Thread identifiers seen in practice never contain a colon (they're
        // Claude.ai URL slugs), so "first colon splits thread from
        // started_at" is safe -- the ISO started_at itself is colon-bearing.
        'batch_key' => $batch['thread'] . ':' . $startedAt,
        'thread' => $batch['thread'],
        'started_at' => $startedAt,
        'ended_at' => $endedAt,
        'duration_seconds' => max(0, strtotime($endedAt) - strtotime($startedAt)),
        'jobs_total' => count($jobs),
        'cc_jobs' => $ccJobs,
        'command_jobs' => $commandJobs,
        'succeeded' => $succeeded,
        'errored' => $errored,
        'longest_job' => [
            'id' => $longest['id'],
            'name' => $longest['name'],
            'duration_seconds' => $longest['duration_seconds'],
        ],
        // No dispatch-anyway/re-fire/rescue events are queryable server-side
        // (they're browser-extension-side, in-memory/chrome.storage only --
        // see db.php's pending_refires table doc for the closest existing
        // server-side analogue, which doesn't cover this) -- so there's no
        // way to say "this batch ran with zero human intervention" for
        // history. Left null rather than guessed. Forward-looking hook: if
        // those events ever get a durable server-side log, this can flip to
        // true/false by checking whether any such event's timestamp falls
        // inside [started_at, ended_at] for the batch's thread.
        'autonomous' => null,
    ];
}

if (isset($_GET['batch']) && $_GET['batch'] !== '') {
    $batchKey = (string) $_GET['batch'];
    [$thread, $startedAt] = array_pad(explode(':', $batchKey, 2), 2, null);
    if ($thread === null || $startedAt === null) {
        jsonResponse(['error' => 'malformed batch key'], 400);
        exit;
    }

    $stmt = $pdo->prepare(
        "SELECT id, thread, name, payload, created_at, updated_at, outcome FROM jobs
         WHERE thread = :thread ORDER BY created_at ASC, id ASC"
    );
    $stmt->execute(['thread' => $thread]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $batch = null;
    foreach (clusterJobsIntoBatches($rows, $gapSeconds) as $candidate) {
        if ($candidate['jobs'][0]['created_at'] === $startedAt) {
            $batch = $candidate;
            break;
        }
    }

    if ($batch === null) {
        jsonResponse(['error' => 'batch not found'], 404);
        exit;
    }

    $jobs = $batch['jobs'];
    $truncated = count($jobs) > MAX_BATCH_DETAIL_JOBS;
    $jobs = array_slice($jobs, 0, MAX_BATCH_DETAIL_JOBS);

    jsonResponse([
        'batch_key' => $batchKey,
        'jobs_total' => count($batch['jobs']),
        'truncated' => $truncated,
        'jobs' => array_map(function (array $job) {
            return [
                'id' => $job['id'],
                'name' => $job['name'],
                'type' => $job['is_command'] ? 'command' : 'cc',
                'model' => $job['model'],
                'duration_seconds' => $job['duration_seconds'],
                'outcome' => $job['outcome'],
            ];
        }, $jobs),
    ]);
    exit;
}

// Full listing: every threaded job, one pass, clustered into batches.
// payload/name are the only per-job text pulled -- no result blobs.
$rows = $pdo->query(
    "SELECT id, thread, name, payload, created_at, updated_at, outcome FROM jobs
     WHERE thread IS NOT NULL AND thread != '' ORDER BY thread ASC, created_at ASC, id ASC"
)->fetchAll(PDO::FETCH_ASSOC);

$allBatches = array_map('summarizeBatch', clusterJobsIntoBatches($rows, $gapSeconds));

// Records are all-time, computed off the full clustered set before ?limit
// narrows what's returned in `batches` below.
$records = ['longest_batch' => null, 'most_jobs_batch' => null, 'top_threads' => []];
if (count($allBatches) > 0) {
    $byDuration = $allBatches;
    usort($byDuration, fn($a, $b) => $b['duration_seconds'] <=> $a['duration_seconds']);
    $records['longest_batch'] = $byDuration[0];

    $byJobCount = $allBatches;
    usort($byJobCount, fn($a, $b) => $b['jobs_total'] <=> $a['jobs_total']);
    $records['most_jobs_batch'] = $byJobCount[0];

    // Per-thread best (by duration), top 3 threads.
    $bestPerThread = [];
    foreach ($allBatches as $batch) {
        $t = $batch['thread'];
        if (!isset($bestPerThread[$t]) || $batch['duration_seconds'] > $bestPerThread[$t]['duration_seconds']) {
            $bestPerThread[$t] = $batch;
        }
    }
    $topThreads = array_values($bestPerThread);
    usort($topThreads, fn($a, $b) => $b['duration_seconds'] <=> $a['duration_seconds']);
    $records['top_threads'] = array_map(
        fn($b) => ['thread' => $b['thread'], 'best_batch' => $b],
        array_slice($topThreads, 0, 3)
    );
}

usort($allBatches, fn($a, $b) => strcmp($b['started_at'], $a['started_at']));

jsonResponse([
    'batches' => array_slice($allBatches, 0, $limit),
    'total_batches' => count($allBatches),
    'records' => $records,
    'gap_seconds' => $gapSeconds,
]);
