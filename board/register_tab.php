<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $thread = $_GET['thread'] ?? '';
    if ($thread === '') {
        jsonResponse(['error' => 'thread is required'], 400);
        exit;
    }

    $pdo = getDb();
    $stmt = $pdo->prepare('SELECT thread, tab_id, updated_at FROM threads WHERE thread = :thread');
    $stmt->execute(['thread' => $thread]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($row === false) {
        jsonResponse(['error' => 'thread not found'], 404);
        exit;
    }

    jsonResponse([
        'thread' => $row['thread'],
        'tabId' => (int) $row['tab_id'],
        'updated_at' => $row['updated_at'],
    ]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$input = readJsonBody();
if (!isset($input['thread'], $input['tabId']) || $input['thread'] === '') {
    jsonResponse(['error' => 'thread and tabId are required'], 400);
    exit;
}

$pdo = getDb();
$stmt = $pdo->prepare(
    'INSERT INTO threads (thread, tab_id, updated_at) VALUES (:thread, :tab_id, :now)
     ON CONFLICT(thread) DO UPDATE SET tab_id = excluded.tab_id, updated_at = excluded.updated_at'
);
$stmt->execute([
    'thread' => (string) $input['thread'],
    'tab_id' => (int) $input['tabId'],
    'now' => isoNow(),
]);

jsonResponse(['ok' => true]);
