<?php
declare(strict_types=1);

// Bug A observability: delivery-loss Pushover relay.
//
// The browser extension (background.js) has no Pushover credentials of its
// own -- the token/user live in privateDir()/pushover.config.php, OUTSIDE the
// web root, so they never ship in the distributed extension (see pushover.php).
// So when the extension's send state machine hits a TERMINAL not-delivered
// state -- the give-up in handleDeliveryFailure, or the user-text-guard wake
// path that ACKs delivered_at without ever typing the payload -- it POSTs here
// and this endpoint fires the phone buzz server-side via sendPushoverNotification.
//
// STRICTLY observability: this endpoint touches NO job/delivery state. It reads
// {job_id, thread, reason} and sends a notification. De-duping is the caller's
// job (background.js alertDeliveryLoss pages each jobId at most once); this just
// forwards whatever it's told, best-effort, and always 200s so a Pushover
// hiccup never surfaces as a delivery error on the client.
//
// db.php pulls in pushover.php (sendPushoverNotification) and isoNow().
require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$input = readJsonBody();
if (!isset($input['job_id']) || $input['job_id'] === '') {
    jsonResponse(['error' => 'job_id is required'], 400);
    exit;
}

$jobId = (string) $input['job_id'];
$thread = isset($input['thread']) && $input['thread'] !== '' ? (string) $input['thread'] : 'unknown';
$reason = isset($input['reason']) && $input['reason'] !== '' ? (string) $input['reason'] : 'not-delivered';

$title = 'CCSW: job result LOST';
$message = sprintf(
    "Job %s (thread %s) finished but its result never reached chat.\nReason: %s",
    $jobId,
    $thread,
    $reason
);

sendPushoverNotification($title, $message);

jsonResponse(['ok' => true]);
