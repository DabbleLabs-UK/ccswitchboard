<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

// Ack-based delivery (fixes wakes vanishing during tab churn): GET claims
// the oldest not-yet-claimed (or claim-expired) wake but does NOT delete it
// -- only a POST {thread, ack:true} from the extension, sent once
// background.js's send state machine confirms the wake-prompt actually
// landed in chat, deletes the row for good. An unacked claim (delivery
// failed, tab closed mid-send, service worker restarted) is simply
// re-offered once WAKE_CLAIM_DEBOUNCE_SECONDS has passed -- see db.php.
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = readJsonBody();
    $thread = is_string($body['thread'] ?? null) ? $body['thread'] : null;
    $repo = is_string($body['repo'] ?? null) ? $body['repo'] : null;
    $ack = ($body['ack'] ?? false) === true;

    if ($thread === null || $thread === '' || $repo === null || $repo === '' || !$ack) {
        jsonResponse(['error' => 'thread, repo and ack required'], 400);
        exit;
    }

    // Scoped to thread AND repo -- a thread can hold a wake for more than one
    // repo at once (see db.php's wakes table), so deleting by thread alone
    // would wipe a second repo's still-unacked wake the moment the first one
    // gets acked.
    $pdo = getDb();
    $stmt = $pdo->prepare('DELETE FROM wakes WHERE thread = :thread AND repo = :repo');
    $stmt->execute(['thread' => $thread, 'repo' => $repo]);
    jsonResponse(['ok' => true]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$pdo = getDb();
$pdo->exec('BEGIN IMMEDIATE');

try {
    $cutoff = gmdate('Y-m-d\TH:i:s\Z', time() - WAKE_CLAIM_DEBOUNCE_SECONDS);
    $stmt = $pdo->prepare(
        'SELECT thread, repo FROM wakes
         WHERE claimed_at IS NULL OR claimed_at < :cutoff
         ORDER BY requested_at ASC LIMIT 1'
    );
    $stmt->execute(['cutoff' => $cutoff]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($row === false) {
        $pdo->exec('COMMIT');
        jsonResponse(['thread' => null]);
        exit;
    }

    $claimStmt = $pdo->prepare('UPDATE wakes SET claimed_at = :now WHERE thread = :thread AND repo = :repo');
    $claimStmt->execute(['now' => isoNow(), 'thread' => $row['thread'], 'repo' => $row['repo']]);
    $pdo->exec('COMMIT');
} catch (Throwable $e) {
    $pdo->exec('ROLLBACK');
    throw $e;
}

jsonResponse(['thread' => $row['thread'], 'repo' => $row['repo']]);
