<?php
declare(strict_types=1);

// The set of block identities (browser-extension content.js's
// fingerprintBlockStable) that have ALREADY dispatched a job for a given
// thread -- recorded on jobs.stable_key by job.php, see db.php.
//
//   GET ?thread=<t>&since_days=<d>  -> {thread, sinceDays, since, stableKeys: [...]}
//
// One half of the durable eligibility rule replacing the extension's per-tab
// in-memory send-guard (beacon.php is the other): a block dispatches iff its
// stableKey is NOT in this set AND a recent user-send beacon exists for its
// thread.
//
// Its own endpoint rather than a param on jobs.php, which the client will hit
// on every block-arrival decision. jobs.php is the board's expensive read: it
// runs the whole reap-sweep set unthrottled (dead/wedged/orphaned-lock/stale
// jobs), checkPlanQuietWakes and checkAgentOfflineAlert -- each a BEGIN
// IMMEDIATE write, two of them able to fire a Pushover push -- and then
// decodes every job's payload to build fat rows. None of that belongs on a
// yes/no dispatch check. This endpoint is one covering-index scan
// (idx_jobs_thread_stable_key) and no writes.

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$thread = isset($_GET['thread']) ? (string) $_GET['thread'] : '';
if ($thread === '') {
    jsonResponse(['error' => 'thread is required'], 400);
    exit;
}

$pdo = getDb();

// AGE WINDOW. The client treats a key's presence here as "this block already
// ran -- ignore it silently, forever". Left unbounded that is a one-way ratchet
// over a thread's entire history: the set grows without limit, and any key in
// it suppresses its block permanently, so a single stale or colliding entry
// would hold a block down with no way back. Bounding the lookback keeps the set
// proportional to recent work and gives every suppression an expiry date.
//
// Absent/invalid since_days = no filter (every dispatch ever), preserving the
// endpoint's original behaviour for any caller that doesn't ask for a window.
// Clamped rather than rejected: an out-of-range value is a client bug, and
// answering with a sane window beats 400-ing a dispatch check into failure.
$sinceDays = null;
if (isset($_GET['since_days']) && is_numeric($_GET['since_days'])) {
    $sinceDays = max(0.0, min(3650.0, (float) $_GET['since_days']));
}

// Same fixed-width UTC format isoNow() writes into created_at
// ('Y-m-d\TH:i:s\Z'), which is why a plain string >= comparison orders these
// correctly -- the same trick the reaper's created_at range scans already use
// in db.php. idx_jobs_created_at exists, but the thread predicate is the
// selective one here and idx_jobs_thread_stable_key still covers it.
$since = $sinceDays === null
    ? null
    : gmdate('Y-m-d\TH:i:s\Z', (int) (time() - (int) round($sinceDays * 86400)));

// Every status counts, not just 'done': a block that dispatched is spent the
// moment its job row exists, whatever became of that job afterwards. A
// pending/running one has plainly already fired, and a job that errored or
// was cancelled must not silently re-fire off the back of the same block --
// re-running it is a deliberate act (the board's Resume, a manual re-send),
// never something the arrival of an old block should trigger by itself.
//
// #84 (threadless-block triple-dispatch): the caller's `thread` param is
// really "the bucket to fetch dispatched keys for" -- content.js's
// resolveDedupBucket() result, not necessarily jobs.thread. Matching against
// EITHER column keeps this back-compatible both ways: a threaded block's
// dispatch_bucket equals its thread (written identically by job.php), so the
// `thread = :bucket` half alone already covers it exactly as before this
// column existed; a threadless block's dispatch_bucket is the conversation's
// URL identity, which the `dispatch_bucket = :bucket` half now also matches;
// and a row from a dispatcher that never sent dispatch_bucket (NULL) is still
// found via `thread = :bucket` same as always.
$sql = 'SELECT DISTINCT stable_key FROM jobs WHERE (thread = :bucket OR dispatch_bucket = :bucket) AND stable_key IS NOT NULL';
$params = ['bucket' => $thread];
if ($since !== null) {
    $sql .= ' AND created_at >= :since';
    $params['since'] = $since;
}

$stmt = $pdo->prepare($sql);
$stmt->execute($params);
$stableKeys = $stmt->fetchAll(PDO::FETCH_COLUMN);

jsonResponse([
    'thread' => $thread,
    // Echoed back so a client can tell "no keys because nothing ran recently"
    // apart from "no keys because my since_days never reached the relay".
    'sinceDays' => $sinceDays,
    'since' => $since,
    // array_values: FETCH_COLUMN already gives a list, but json_encode turns
    // an empty PHP array into [] and a non-list into an object -- this keeps
    // the field unambiguously a JSON array for the client either way.
    'stableKeys' => array_values($stableKeys),
]);
