<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

// Readonly diagnostic dump of the repo-lock machinery (locks, waiters, wakes
// tables, see db.php's releaseLockAndWake) -- for inspecting a repo-free wake
// that went missing, or the lock-handoff fairness question, without a human
// relaying SQLite rows by hand.
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$pdo = getDb();

jsonResponse([
    'locks' => $pdo->query('SELECT * FROM locks')->fetchAll(PDO::FETCH_ASSOC),
    'waiters' => $pdo->query('SELECT * FROM waiters ORDER BY requested_at ASC')->fetchAll(PDO::FETCH_ASSOC),
    'wakes' => $pdo->query('SELECT * FROM wakes')->fetchAll(PDO::FETCH_ASSOC),
]);
