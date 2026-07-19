<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$thread = $_GET['thread'] ?? '';
$repo = $_GET['repo'] ?? '';
$label = isset($_GET['session']) && $_GET['session'] !== '' ? (string) $_GET['session'] : 'default';
if ($thread === '' || $repo === '') {
    jsonResponse(['error' => 'thread and repo are required'], 400);
    exit;
}

// M1 multi-machine targeting: a CC session id names a session file on the box
// that created it, so it is only resumable THERE -- sessions is keyed by
// machine (see db.php) and this lookup must filter by it, or a job on one
// machine would resume another machine's conversation.
//
// Absent means 'vm', matching the same default job.php stamps on an untargeted
// dispatch and poll.php assumes for an agent polling with no ?machine=. That
// keeps today's single-machine setup byte-identical: the VM agent doesn't send
// this param, and 'vm' is exactly the machine every existing sessions row was
// backfilled to.
//
// CAVEAT -- the agent must be taught to send this before a SECOND machine goes
// live. AgentCore.cs's LookupSession() currently builds this URL with
// thread/repo/session only (it sends ?machine= on poll.php and in its
// heartbeat/result POSTs, but not here), so an unmodified agent on DELL would
// fall into the 'vm' default and be handed VM session ids -- the precise
// failure this key exists to prevent. The relay cannot infer the caller's
// machine from thread+repo alone, so it can't close this gap from this side.
// The param is additive and already correct once the agent passes it; adding
// `&machine=` to LookupSession() is a required prerequisite for DELL resume,
// deliberately left out of this relay-only change.
$machine = isset($_GET['machine']) && $_GET['machine'] !== '' ? (string) $_GET['machine'] : 'vm';

$pdo = getDb();
$stmt = $pdo->prepare('SELECT session_id FROM sessions WHERE thread = :thread AND repo = :repo AND label = :label AND machine = :machine');
$stmt->execute(['thread' => $thread, 'repo' => $repo, 'label' => $label, 'machine' => $machine]);
$row = $stmt->fetch(PDO::FETCH_ASSOC);

jsonResponse(['session_id' => $row !== false ? $row['session_id'] : null]);
