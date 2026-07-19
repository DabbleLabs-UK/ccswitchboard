<?php
declare(strict_types=1);

// Durable output log: one row per claude.ai generation event, POSTed by the
// browser extension -- when claude.ai started/finished outputting, the
// duration, which model/effort were active, and which thread/tab. Distinct
// from job_output (db.php's per-job streamed CC output chunks) and debug_log
// (debuglog.php's diagnostic ring buffer) -- this is an append-only record of
// claude.ai's own generation timings, never rotated/trimmed.
//
// POST {ts_start, ts_end, duration_ms, model?, effort?, thread?, url?}
//   -> {"ok": true, "id": N}
// GET ?limit=<n>&since=<ISO ts>
//   -> {"ok": true, "rows": [{id, ts_start, ts_end, duration_ms, model,
//        effort, thread, url, received_at}...]} newest-first

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

const OUTPUT_LOG_DEFAULT_LIMIT = 100;
const OUTPUT_LOG_MAX_LIMIT = 500;

$pdo = getDb();
$pdo->exec(
    'CREATE TABLE IF NOT EXISTS output_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts_start TEXT,
        ts_end TEXT,
        duration_ms INTEGER,
        model TEXT,
        effort TEXT,
        thread TEXT,
        url TEXT,
        received_at TEXT
    )'
);

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : OUTPUT_LOG_DEFAULT_LIMIT;
    $limit = max(1, min(OUTPUT_LOG_MAX_LIMIT, $limit));
    $since = isset($_GET['since']) && $_GET['since'] !== '' ? (string) $_GET['since'] : null;

    $sql = 'SELECT id, ts_start, ts_end, duration_ms, model, effort, thread, url, received_at FROM output_log';
    $params = [];
    if ($since !== null) {
        $sql .= ' WHERE received_at > :since';
        $params['since'] = $since;
    }
    $sql .= ' ORDER BY id DESC LIMIT ' . $limit;

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $out = array_map(static function (array $r): array {
        return [
            'id' => (int) $r['id'],
            'ts_start' => $r['ts_start'],
            'ts_end' => $r['ts_end'],
            'duration_ms' => $r['duration_ms'] !== null ? (int) $r['duration_ms'] : null,
            'model' => $r['model'],
            'effort' => $r['effort'],
            'thread' => $r['thread'],
            'url' => $r['url'],
            'received_at' => $r['received_at'],
        ];
    }, $rows);

    jsonResponse(['ok' => true, 'rows' => $out]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$input = readJsonBody();

if (!isset($input['ts_start']) || $input['ts_start'] === ''
    || !isset($input['ts_end']) || $input['ts_end'] === ''
    || !isset($input['duration_ms']) || $input['duration_ms'] === ''
) {
    jsonResponse(['error' => 'ts_start, ts_end, and duration_ms are required'], 400);
    exit;
}

$stmt = $pdo->prepare(
    'INSERT INTO output_log (ts_start, ts_end, duration_ms, model, effort, thread, url, received_at)
     VALUES (:ts_start, :ts_end, :duration_ms, :model, :effort, :thread, :url, :received_at)'
);
$stmt->execute([
    'ts_start' => (string) $input['ts_start'],
    'ts_end' => (string) $input['ts_end'],
    'duration_ms' => (int) $input['duration_ms'],
    'model' => isset($input['model']) && $input['model'] !== '' ? (string) $input['model'] : null,
    'effort' => isset($input['effort']) && $input['effort'] !== '' ? (string) $input['effort'] : null,
    'thread' => isset($input['thread']) && $input['thread'] !== '' ? (string) $input['thread'] : null,
    'url' => isset($input['url']) && $input['url'] !== '' ? (string) $input['url'] : null,
    'received_at' => isoNow(),
]);

jsonResponse(['ok' => true, 'id' => (int) $pdo->lastInsertId()]);
