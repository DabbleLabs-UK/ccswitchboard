<?php
declare(strict_types=1);

// Per-thread record of when a real USER-authored send last landed in that
// thread's chat -- posted by the browser extension the moment it observes one.
//
// This is one of the two durable facts the extension's dispatch decision is
// being rebuilt on (the other is jobs.stable_key, served by dispatched.php):
// a block dispatches iff its stableKey has NOT already dispatched AND a recent
// user-send exists for its thread. Both live on the relay precisely because
// the old in-memory per-tab guard did not survive a service-worker restart or
// a tab close, which is how the same block came to re-fire.
//
// Nothing reads this table yet -- the client still runs the old in-memory
// logic and is rewired in a later stage.
//
//   POST {thread, sentAt?}  -> upsert the thread's beacon, {ok: true}
//   GET  ?thread=<t>        -> {thread, sentAt}   (sentAt null if no beacon)
//   GET                     -> {beacons: [...]}   (all of them, one call)
//
// sentAt is client epoch MILLISECONDS (Date.now()); see db.php's beacon table
// for why the relay also stamps its own received_at alongside it.

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $pdo = getDb();
    $thread = isset($_GET['thread']) ? (string) $_GET['thread'] : '';

    // No thread: hand back the whole (small, one-row-per-thread) table, so the
    // extension's background worker can cache every thread's beacon in a
    // single request rather than one per thread it is tracking.
    if ($thread === '') {
        $rows = $pdo->query(
            'SELECT thread, sent_at, received_at FROM beacon ORDER BY sent_at DESC'
        )->fetchAll(PDO::FETCH_ASSOC);

        jsonResponse(['beacons' => array_map(fn($row) => [
            'thread' => $row['thread'],
            'sentAt' => (int) $row['sent_at'],
            'receivedAt' => $row['received_at'],
        ], $rows)]);
        exit;
    }

    $stmt = $pdo->prepare('SELECT sent_at, received_at FROM beacon WHERE thread = :thread');
    $stmt->execute(['thread' => $thread]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    // A thread with no beacon is an ordinary answer, not an error: it just
    // means no user-send has ever been observed there. The client reads a null
    // sentAt as "not eligible", same as an ancient one.
    jsonResponse([
        'thread' => $thread,
        'sentAt' => $row !== false ? (int) $row['sent_at'] : null,
        'receivedAt' => $row !== false ? $row['received_at'] : null,
    ]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$input = readJsonBody();
$thread = isset($input['thread']) ? (string) $input['thread'] : '';
if ($thread === '') {
    jsonResponse(['error' => 'thread is required'], 400);
    exit;
}

// An omitted sentAt means "the send just happened" -- the relay's own clock is
// the best available answer, and a beacon with no timestamp at all would be
// useless to the recency check this table exists to serve.
$sentAt = isset($input['sentAt']) && is_numeric($input['sentAt'])
    ? (int) $input['sentAt']
    : (int) round(microtime(true) * 1000);

$pdo = getDb();
$stmt = $pdo->prepare(
    'INSERT INTO beacon (thread, sent_at, received_at) VALUES (:thread, :sent_at, :now)
     ON CONFLICT(thread) DO UPDATE SET sent_at = excluded.sent_at, received_at = excluded.received_at'
);
$stmt->execute(['thread' => $thread, 'sent_at' => $sentAt, 'now' => isoNow()]);

jsonResponse(['ok' => true]);
