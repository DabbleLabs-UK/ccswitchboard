<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $pdo = getDb();
    $pdo->exec('BEGIN IMMEDIATE');

    try {
        $row = $pdo->query(
            'SELECT thread FROM focus_requests ORDER BY requested_at ASC LIMIT 1'
        )->fetch(PDO::FETCH_ASSOC);

        if ($row === false) {
            $pdo->exec('COMMIT');
            jsonResponse(['thread' => null]);
            exit;
        }

        $stmt = $pdo->prepare('DELETE FROM focus_requests WHERE thread = :thread');
        $stmt->execute(['thread' => $row['thread']]);
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }

    jsonResponse(['thread' => $row['thread']]);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$input = readJsonBody();
if (!isset($input['thread']) || $input['thread'] === '') {
    jsonResponse(['error' => 'thread is required'], 400);
    exit;
}

$pdo = getDb();
$stmt = $pdo->prepare(
    'INSERT INTO focus_requests (thread, requested_at) VALUES (:thread, :now)
     ON CONFLICT(thread) DO UPDATE SET requested_at = excluded.requested_at'
);
$stmt->execute([
    'thread' => (string) $input['thread'],
    'now' => isoNow(),
]);

jsonResponse(['ok' => true]);
