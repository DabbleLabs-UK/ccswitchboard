<?php
declare(strict_types=1);

// Action List: a queue of manual actions for Jody to do himself, authored by
// Claude via the browser extension's persistent Action List pill
// (browser-extension/content.js's renderActionListPill).
// Claude adds items either via an `actions` field riding a normal ccsw job
// dispatch, or a standalone plan-only-style ccsw block -- both routed here
// through background.js's ccsw-actions-add handler, same pattern as
// plan.php. Jody clears items himself from the extension's dialog (`clear`
// op below) -- there's no changelog, a cleared item is just deleted.
//
// Each action optionally carries the chat `thread` it was authored from, so
// the list can eventually be shown per-thread rather than as the single
// global list it started as. An action with no thread (NULL) is an untagged
// / 'Global' item -- which is what every row predating that column is, and
// what any caller that doesn't tag its adds keeps producing.
//
// GET                  -> {"actions": [{"id","text","tier","thread","created_at"}...], "counts": {...}}
// GET ?thread=<thread> -> the same, narrowed to actions tagged with that thread
// GET ?global=1        -> the same, narrowed to the untagged (thread IS NULL) bucket
// POST {"add": [{"text","tier","thread"?}...], "thread"?: <thread>}
//                      -> add item(s), returns the same shape as GET (unfiltered)
// POST {"clear": [id, ...]}            -> delete item(s) by id, returns the same shape as GET
// Both `add` and `clear` may be sent in the same POST body.
// GET/POST ?op=dedup_sweep -> maintenance: deletes exact-normalised-duplicate
//                      OPEN items, keeping the oldest per (thread, text)
//                      group, returns {"ok","removed","removed_ids", ...GET shape}
//
// The GET filter is opt-in: with no param at all the FULL list comes back,
// exactly as it did before threads existed. `?thread=` can only ever name a
// real thread -- a NULL thread has no value to pass -- so the Global bucket
// gets its own boolean param rather than a reserved sentinel thread name
// (which a real thread could one day collide with). `?global=1` wins if both
// are somehow sent; every other value of ?global= is ignored.
//
// #61: the `add` path also normalises (trim/collapse-whitespace/lowercase)
// each incoming text and skips the insert if it matches an already-open item
// in the same thread -- Claude re-authoring the same actions block (or a
// retried/duplicated dispatch) no longer produces duplicate rows.

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

const ACTION_TIERS = ['blocking', 'recommended', 'nice_to_have'];

// A thread tag off the wire: trimmed, with the empty string normalized to
// null so "" and "absent" mean the same thing (untagged) everywhere.
function normalizeThread($value): ?string
{
    if (!is_string($value)) {
        return null;
    }
    $thread = trim($value);
    return $thread === '' ? null : $thread;
}

// #61 dedup: collapses whitespace/case differences so "Reload  extension" and
// "reload extension" are recognised as the same open item. Used both by the
// add-path (skip a duplicate insert) and by the dedup_sweep maintenance op
// (group existing rows) -- keep the two in agreement.
function normalizeActionText(string $text): string
{
    return strtolower(trim(preg_replace('/\s+/', ' ', $text)));
}

// #61 one-off/maintenance sweep: removes exact-normalised-duplicate OPEN
// items (there is no done/dismissed flag -- every row in the table IS open),
// keeping the oldest (lowest id) per (thread, normalized text) group.
function runDedupSweep(PDO $pdo): array
{
    $rows = $pdo->query('SELECT id, text, thread FROM actions ORDER BY id ASC')->fetchAll(PDO::FETCH_ASSOC);

    $seenGroups = []; // "thread\0normalizedText" => kept id
    $toDelete = [];
    foreach ($rows as $row) {
        $groupKey = ($row['thread'] ?? '') . "\0" . normalizeActionText((string) $row['text']);
        if (isset($seenGroups[$groupKey])) {
            $toDelete[] = (int) $row['id'];
        } else {
            $seenGroups[$groupKey] = (int) $row['id'];
        }
    }

    if ($toDelete !== []) {
        $placeholders = implode(',', array_fill(0, count($toDelete), '?'));
        $stmt = $pdo->prepare("DELETE FROM actions WHERE id IN ($placeholders)");
        $stmt->execute($toDelete);
    }

    return ['ok' => true, 'removed' => count($toDelete), 'removed_ids' => $toDelete] + currentActionsState($pdo);
}

// $globalOnly narrows to the untagged bucket and takes precedence over
// $thread; with neither, every row comes back regardless of thread.
function currentActionsState(PDO $pdo, ?string $thread = null, bool $globalOnly = false): array
{
    if ($globalOnly) {
        $stmt = $pdo->query('SELECT id, text, tier, thread, created_at FROM actions WHERE thread IS NULL ORDER BY id ASC');
    } elseif ($thread !== null) {
        $stmt = $pdo->prepare('SELECT id, text, tier, thread, created_at FROM actions WHERE thread = :thread ORDER BY id ASC');
        $stmt->execute(['thread' => $thread]);
    } else {
        $stmt = $pdo->query('SELECT id, text, tier, thread, created_at FROM actions ORDER BY id ASC');
    }
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $actions = array_map(fn(array $r) => [
        'id' => (int) $r['id'],
        'text' => $r['text'],
        'tier' => $r['tier'],
        'thread' => $r['thread'],
        'created_at' => $r['created_at'],
    ], $rows);

    $counts = ['blocking' => 0, 'recommended' => 0, 'nice_to_have' => 0];
    foreach ($actions as $action) {
        $counts[$action['tier']]++;
    }

    return ['actions' => $actions, 'counts' => $counts];
}

$pdo = getDb();

// #61 maintenance sweep: a one-off cleanup branch, not part of the normal
// GET/POST contract above -- deliberately checked before the method dispatch
// so it works with a plain authenticated `curl` GET, e.g.
//   curl -H "X-CCSW-Token: <token>" "https://.../actions.php?op=dedup_sweep"
if (($_GET['op'] ?? '') === 'dedup_sweep') {
    jsonResponse(runDedupSweep($pdo));
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $globalOnly = ($_GET['global'] ?? '') === '1';
    $thread = $globalOnly ? null : normalizeThread($_GET['thread'] ?? null);
    jsonResponse(currentActionsState($pdo, $thread, $globalOnly));
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$input = readJsonBody();

if (isset($input['add']) && is_array($input['add'])) {
    $now = isoNow();
    // A top-level `thread` tags every item in the batch -- the usual case,
    // since one ccsw block is authored from one chat thread. A per-item
    // `thread` overrides it, so a single batch can still fan items out across
    // threads. Neither present (today's client) leaves the item untagged.
    $batchThread = normalizeThread($input['thread'] ?? null);
    $stmt = $pdo->prepare('INSERT INTO actions (text, tier, thread, created_at) VALUES (:text, :tier, :thread, :now)');

    // #61 dedup: normalized-text -> true, per thread bucket ('' = untagged),
    // lazily populated from the DB the first time a thread is seen so a
    // duplicate already sitting in the table is caught, then kept updated as
    // this batch inserts so two copies of the same text riding one batch
    // don't both land either.
    $existingByThread = [];
    foreach ($input['add'] as $item) {
        if (!is_array($item)) {
            continue;
        }
        $text = isset($item['text']) ? trim((string) $item['text']) : '';
        $tier = isset($item['tier']) ? (string) $item['tier'] : '';
        if ($text === '' || !in_array($tier, ACTION_TIERS, true)) {
            continue; // silently skip malformed items rather than reject the whole batch
        }
        $thread = normalizeThread($item['thread'] ?? null) ?? $batchThread;
        $threadKey = $thread ?? '';
        $normalized = normalizeActionText($text);

        if (!array_key_exists($threadKey, $existingByThread)) {
            if ($thread === null) {
                $existingRows = $pdo->query('SELECT text FROM actions WHERE thread IS NULL')->fetchAll(PDO::FETCH_COLUMN);
            } else {
                $existingStmt = $pdo->prepare('SELECT text FROM actions WHERE thread = :thread');
                $existingStmt->execute(['thread' => $thread]);
                $existingRows = $existingStmt->fetchAll(PDO::FETCH_COLUMN);
            }
            $set = [];
            foreach ($existingRows as $existingText) {
                $set[normalizeActionText((string) $existingText)] = true;
            }
            $existingByThread[$threadKey] = $set;
        }

        if (isset($existingByThread[$threadKey][$normalized])) {
            continue; // duplicate of an already-open item in this thread -- treated as already added
        }

        $stmt->execute(['text' => $text, 'tier' => $tier, 'thread' => $thread, 'now' => $now]);
        $existingByThread[$threadKey][$normalized] = true;
    }
}

if (isset($input['clear']) && is_array($input['clear'])) {
    $ids = array_values(array_unique(array_filter(
        array_map('intval', $input['clear']),
        fn(int $id) => $id > 0
    )));
    if ($ids !== []) {
        $placeholders = implode(',', array_fill(0, count($ids), '?'));
        $stmt = $pdo->prepare("DELETE FROM actions WHERE id IN ($placeholders)");
        $stmt->execute($ids);
    }
}

jsonResponse(['ok' => true] + currentActionsState($pdo));
