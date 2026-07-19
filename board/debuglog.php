<?php
declare(strict_types=1);

// Central debug log -- the cross-tab event stream.
//
// A content script only ever sees its own tab, so it can't answer "what is
// the extension doing across all these tabs". Events funnel
// content.js's logEvent() -> background.js's ccsw-debug-event ring buffer
// (capped, throttle-flushed) -> here, where they land in the `debug_log`
// table (created in db.php). Claude then reads them back either via the
// Advanced panel's "Send debug log to chat" button or by emitting a
// {"debuglog": true} ccsw block, both of which route through
// background.js's ccsw-debuglog-deliver handler to this endpoint's GET.
//
// Distinct from the older debug_log.php (note the underscore), which appends
// free-form {tag, data} lines to a flat file for curl-tailing. This one is
// the structured, queryable, extension-authored event stream.
//
// GET  ?since=<id>&limit=<n>&type=<t>  -> {"events": [{id, ts, build, thread, type, detail}...]}
//        since : return only events with id > since (0/absent = no lower bound)
//        limit : max events, newest-first internally but returned oldest-first
//        type  : exact-match filter on the event type (e.g. "held_decision")
// POST {"events": [{ts, build, thread, type, detail}...]} -> {"ok": true, "inserted": n}
//
// Rotation: after each POST batch the table is trimmed to the newest
// DEBUG_LOG_KEEP_ROWS rows. This is a diagnostic tail, not an audit trail.

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

const DEBUG_LOG_KEEP_ROWS = 2000;
const DEBUG_LOG_DEFAULT_LIMIT = 150;
const DEBUG_LOG_MAX_LIMIT = 1000;
// Guards against a runaway detail blob bloating the table -- the ring buffer
// upstream is capped by count, not by payload size.
const DEBUG_LOG_MAX_DETAIL_BYTES = 4000;

$pdo = getDb();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : DEBUG_LOG_DEFAULT_LIMIT;
    $limit = max(1, min(DEBUG_LOG_MAX_LIMIT, $limit));
    $since = isset($_GET['since']) ? (int) $_GET['since'] : 0;
    $type = isset($_GET['type']) && $_GET['type'] !== '' ? (string) $_GET['type'] : null;

    // Newest-first with LIMIT so we take the TAIL of the log, then reverse to
    // hand back oldest-first -- reading a log top-to-bottom is what the caller
    // (and Claude) actually wants. Doing it the other way round would return
    // the oldest N events, which is never the interesting end.
    $sql = 'SELECT id, ts, build, thread, type, detail FROM debug_log WHERE id > :since';
    $params = ['since' => $since];
    if ($type !== null) {
        $sql .= ' AND type = :type';
        $params['type'] = $type;
    }
    $sql .= ' ORDER BY id DESC LIMIT ' . $limit;

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = array_reverse($stmt->fetchAll(PDO::FETCH_ASSOC));

    $events = array_map(static function (array $r): array {
        // detail round-trips as real JSON rather than an escaped string, so
        // the caller doesn't have to double-decode. A row written before this
        // (or with a malformed blob) degrades to null instead of throwing.
        $detail = null;
        if ($r['detail'] !== null && $r['detail'] !== '') {
            $decoded = json_decode((string) $r['detail'], true);
            $detail = $decoded === null && json_last_error() !== JSON_ERROR_NONE
                ? (string) $r['detail']
                : $decoded;
        }
        return [
            'id' => (int) $r['id'],
            'ts' => $r['ts'],
            'build' => $r['build'],
            'thread' => $r['thread'],
            'type' => $r['type'],
            'detail' => $detail,
        ];
    }, $rows);

    jsonResponse(['events' => $events]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$input = readJsonBody();
$events = isset($input['events']) && is_array($input['events']) ? $input['events'] : [];
if ($events === []) {
    jsonResponse(['ok' => true, 'inserted' => 0]);
    exit;
}

$stmt = $pdo->prepare(
    'INSERT INTO debug_log (ts, build, thread, type, detail) VALUES (:ts, :build, :thread, :type, :detail)'
);

$inserted = 0;
$pdo->beginTransaction();
try {
    foreach ($events as $event) {
        if (!is_array($event)) {
            continue;
        }
        $type = isset($event['type']) ? trim((string) $event['type']) : '';
        if ($type === '') {
            continue; // silently skip malformed events rather than reject the batch
        }

        $detail = null;
        if (array_key_exists('detail', $event) && $event['detail'] !== null) {
            $detail = json_encode($event['detail']);
            if ($detail === false) {
                $detail = null;
            } elseif (strlen($detail) > DEBUG_LOG_MAX_DETAIL_BYTES) {
                $detail = json_encode(['truncated' => true, 'bytes' => strlen($detail)]);
            }
        }

        $stmt->execute([
            // Trust the client's ts when present: it's stamped at the moment
            // the event actually happened, which can be seconds before this
            // throttled flush reaches us. Fall back to now for a malformed one.
            'ts' => isset($event['ts']) && is_string($event['ts']) && $event['ts'] !== '' ? $event['ts'] : isoNow(),
            'build' => isset($event['build']) ? (string) $event['build'] : null,
            'thread' => isset($event['thread']) && $event['thread'] !== '' ? (string) $event['thread'] : null,
            'type' => $type,
            'detail' => $detail,
        ]);
        $inserted++;
    }
    $pdo->commit();
} catch (Throwable $e) {
    $pdo->rollBack();
    jsonResponse(['error' => 'insert failed: ' . $e->getMessage()], 500);
    exit;
}

// Rotate: keep only the newest DEBUG_LOG_KEEP_ROWS rows. Cheap enough to run
// per batch (ids are indexed) and it means the table can never grow without
// bound no matter how chatty a build gets.
$pdo->exec(
    'DELETE FROM debug_log WHERE id <= (
        SELECT MAX(id) - ' . DEBUG_LOG_KEEP_ROWS . ' FROM debug_log
    )'
);

jsonResponse(['ok' => true, 'inserted' => $inserted]);
