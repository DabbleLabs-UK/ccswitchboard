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
if (!isset($input['payload'])) {
    jsonResponse(['error' => 'payload is required'], 400);
    exit;
}

$payload = $input['payload'];
$thread = isset($input['thread']) ? (string) $input['thread'] : null;
$continue = !empty($input['continue']);
$cwd = is_array($payload) && isset($payload['cwd']) ? (string) $payload['cwd'] : '';
$repo = $cwd !== '' ? repoFromCwd($cwd) : null;
$name = is_array($payload) && isset($payload['name']) && $payload['name'] !== '' ? (string) $payload['name'] : null;
$summary = is_array($payload) && isset($payload['summary']) && $payload['summary'] !== '' ? (string) $payload['summary'] : null;
$final = is_array($payload) && !empty($payload['final']);
$isBash = is_array($payload) && isset($payload['type']) && strtolower((string) $payload['type']) === 'bash';

// M1 multi-machine targeting: which machine this job is FOR. poll.php hands a
// job only to an agent polling as this machine (see jobs.target in db.php).
// Absent means 'vm' -- every dispatcher that predates targeting (the browser
// extension, CcswPopup, a manual board dispatch) sends no machine and must keep
// landing on the VM exactly as before. Free-form and unvalidated on purpose,
// same as the `machine` an agent self-reports on poll/heartbeat: the relay
// never holds a machine registry, it just matches the two strings. A typo'd
// target therefore parks the job as pending until an agent claiming that name
// polls -- which is also precisely what lets a job be queued for a machine
// whose agent isn't installed yet.
$target = is_array($payload) && isset($payload['machine']) && $payload['machine'] !== ''
    ? (string) $payload['machine']
    : 'vm';
// Read-only bash peeks (e.g. status checks) don't touch the repo, so they
// skip the repo lock entirely and can run alongside a CC job already
// holding it, instead of queueing behind it as a waiter.
$readonly = $isBash && !empty($input['readonly']);

// The block identity (browser-extension content.js's fingerprintBlockStable)
// this dispatch came from, recorded so a later dispatch of the SAME block can
// be recognised as a duplicate on any tab -- see db.php's jobs.stable_key and
// dispatched.php. Optional and unvalidated on purpose: dispatchers that have
// no block behind them (CcswPopup, a manual board re-fire) and older
// extension builds that don't send it yet both just leave it null.
$stableKey = isset($input['stable_key']) && $input['stable_key'] !== ''
    ? (string) $input['stable_key']
    : null;

// #84 (threadless-block triple-dispatch): the extension's resolved rule-(a)
// dedup bucket -- see db.php's dispatch_bucket column comment. Optional and
// unvalidated, same reasoning as $stableKey above: a dispatcher with no block
// behind it, or an older extension build that doesn't send this yet, just
// leaves it null.
$dispatchBucket = isset($input['dispatch_bucket']) && $input['dispatch_bucket'] !== ''
    ? (string) $input['dispatch_bucket']
    : null;

// The repo(s) to LOCK are independent of $cwd/$repo, which always keeps
// setting CC's working dir/readable scope regardless of what gets locked:
//   - payload.locks: an array of repo names -- lock ALL of them, all-or-
//     nothing, in this one transaction (e.g. a cross-repo job).
//   - payload.lock_repo: a single repo name to lock instead of the one
//     derived from cwd (e.g. cwd is a subrepo/worktree but the lock belongs
//     on its parent/logical repo).
//   - neither present: unchanged -- lock is taken on repoFromCwd($cwd).
$locksField = is_array($payload) && isset($payload['locks']) && is_array($payload['locks'])
    ? array_values(array_unique(array_filter(array_map('strval', $payload['locks']), fn($r) => $r !== '')))
    : [];
$lockRepoField = is_array($payload) && isset($payload['lock_repo']) && $payload['lock_repo'] !== ''
    ? (string) $payload['lock_repo']
    : null;

if ($locksField !== []) {
    $repos = $locksField;
} elseif ($lockRepoField !== null) {
    $repos = [$lockRepoField];
} else {
    $repos = $repo !== null ? [$repo] : [];
}

$pdo = getDb();
$now = isoNow();
$pdo->exec('BEGIN IMMEDIATE');

try {
    if ($repos !== [] && !$readonly) {
        $placeholders = implode(',', array_fill(0, count($repos), '?'));
        $stmt = $pdo->prepare("SELECT repo, thread FROM locks WHERE repo IN ($placeholders)");
        $stmt->execute($repos);
        $held = $stmt->fetchAll(PDO::FETCH_ASSOC);

        if ($held !== []) {
            // All-or-nothing: any ONE of the requested repos already being
            // locked blocks the whole request and acquires none, same as the
            // single-repo path below. Queue as a waiter only on the repos
            // held by a DIFFERENT thread -- per releaseLockAndWake's doc
            // comment in db.php, a thread never waits on its own still-
            // running job, since it'll get that job's real result via
            // result.php's own per-job delivery instead.
            if ($thread !== null) {
                $waiterStmt = $pdo->prepare(
                    'INSERT OR IGNORE INTO waiters (repo, thread, requested_at) VALUES (:repo, :thread, :now)'
                );
                foreach ($held as $lock) {
                    if ($thread === $lock['thread']) {
                        continue;
                    }
                    $waiterStmt->execute(['repo' => $lock['repo'], 'thread' => $thread, 'now' => $now]);
                }
            }

            // Remember the dropped job so it can be surfaced again once each
            // blocking repo frees up (see db.php's pending_refires table and
            // releaseLockAndWake) -- one row per held repo, queued (not
            // deduped/latest-wins), so a repo locked through several drops in
            // a row surfaces every one of them rather than silently losing
            // all but the last.
            $refireStmt = $pdo->prepare(
                'INSERT INTO pending_refires (repo, thread, payload, dropped_at) VALUES (:repo, :thread, :payload, :now)'
            );
            $refirePayload = json_encode($input);
            foreach ($held as $lock) {
                $refireStmt->execute([
                    'repo' => $lock['repo'],
                    'thread' => $thread,
                    'payload' => $refirePayload,
                    'now' => $now,
                ]);
            }

            $pdo->exec('COMMIT');
            jsonResponse(['locked' => true, 'held_by' => $held[0]['thread'], 'held' => $held], 409);
            exit;
        }
    }

    $stmt = $pdo->prepare(
        'INSERT INTO jobs (payload, thread, continue, name, summary, final, stable_key, dispatch_bucket, target, status, created_at, updated_at) VALUES (:payload, :thread, :continue, :name, :summary, :final, :stable_key, :dispatch_bucket, :target, \'pending\', :now, :now)'
    );
    $stmt->execute([
        'payload' => json_encode($payload),
        'thread' => $thread,
        'continue' => $continue ? 1 : 0,
        'name' => $name,
        'summary' => $summary,
        'final' => $final ? 1 : 0,
        'stable_key' => $stableKey,
        'dispatch_bucket' => $dispatchBucket,
        'target' => $target,
        'now' => $now,
    ]);
    $jobId = (int) $pdo->lastInsertId();

    bumpPlanActivity($pdo, $thread, $now);

    if ($repos !== [] && !$readonly) {
        $stmt = $pdo->prepare(
            'INSERT INTO locks (repo, thread, job_id, locked_at) VALUES (:repo, :thread, :job_id, :now)'
        );
        foreach ($repos as $r) {
            $stmt->execute([
                'repo' => $r,
                'thread' => $thread,
                'job_id' => $jobId,
                'now' => $now,
            ]);
        }
    }

    $pdo->exec('COMMIT');
} catch (Throwable $e) {
    $pdo->exec('ROLLBACK');
    throw $e;
}

jsonResponse(['id' => $jobId]);
