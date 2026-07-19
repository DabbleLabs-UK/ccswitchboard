<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

$jobId = isset($_GET['job_id']) ? (int) $_GET['job_id'] : 0;
if ($jobId <= 0) {
    jsonResponse(['error' => 'job_id is required'], 400);
    exit;
}

$after = isset($_GET['after']) ? (int) $_GET['after'] : 0;

$pdo = getDb();
$stmt = $pdo->prepare(
    'SELECT seq, text, at FROM job_output WHERE job_id = :job_id AND seq > :after ORDER BY seq ASC'
);
$stmt->execute(['job_id' => $jobId, 'after' => $after]);
$rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

$chunks = array_map(fn($row) => [
    'seq' => (int) $row['seq'],
    'text' => $row['text'],
    'at' => $row['at'],
], $rows);

jsonResponse(['chunks' => $chunks]);
