<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

// Standalone housekeeping tick. Runs the full sweep set on an EXTERNAL
// schedule (cron) so reaping/alerts no longer depend on request traffic
// (the agent's poll.php or a browser tab hitting jobs.php). Belt-and-braces:
// the same sweeps still run opportunistically from poll.php/jobs.php, but
// this endpoint is the reliable cadence -- and the ONLY thing that runs the
// sweeps when the agent is dead AND no board/extension tab is open, which is
// exactly when stuck jobs/locks would otherwise never be reclaimed.
//
// Cron (cPanel/LiteSpeed): curl this URL with the X-CCSW-Token header every
// ~30-60s. Routes through jsonResponse() (the nginx cache-cookie gotcha) and
// requireAuth() like every other endpoint, so it works under grace mode now
// and under enforced auth later.

if ($_SERVER['REQUEST_METHOD'] !== 'GET' && $_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$pdo = getDb();

reapDeadJobs($pdo);
reapWedgedJobs($pdo);
checkUndeliveredResults($pdo);
reapOrphanedLocks($pdo);
reapStalePendingJobs($pdo);
checkPlanQuietWakes($pdo);
checkAgentOfflineAlert($pdo);

jsonResponse(['ok' => true, 'ticked_at' => isoNow()]);
