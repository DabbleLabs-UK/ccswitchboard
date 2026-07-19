<?php
declare(strict_types=1);

// M3: persists a thread's current plan (browser-extension/content.js's
// renderPlanPills, sent via background.js's ccsw-plan-update handler)
// so db.php's checkPlanQuietWakes() can tell whether a quiet thread still
// has an open plan. An empty/omitted plan clears the row -- the plan is
// considered finished, so there's nothing left to nudge about.

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

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

$plan = isset($input['plan']) && is_array($input['plan'])
    ? array_values(array_filter(array_map('strval', $input['plan']), fn($s) => trim($s) !== ''))
    : [];

$pdo = getDb();

if ($plan === []) {
    $stmt = $pdo->prepare('DELETE FROM plans WHERE thread = :thread');
    $stmt->execute(['thread' => $thread]);
    jsonResponse(['ok' => true]);
    exit;
}

$stmt = $pdo->prepare(
    'INSERT INTO plans (thread, plan, updated_at, nudged_at) VALUES (:thread, :plan, :now, NULL)
     ON CONFLICT(thread) DO UPDATE SET plan = excluded.plan, updated_at = excluded.updated_at, nudged_at = NULL'
);
$stmt->execute(['thread' => $thread, 'plan' => json_encode($plan), 'now' => isoNow()]);

jsonResponse(['ok' => true]);
