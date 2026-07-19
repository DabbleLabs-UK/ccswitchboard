<?php
declare(strict_types=1);

require __DIR__ . '/db.php';
require __DIR__ . '/auth.php';
requireAuth();

// Lightweight relay-protocol-version lookup -- lets any component (agent,
// browser extension, popup, CU) read PROTOCOL_VERSION (see db.php) without
// pulling in a full job/board payload. No enforcement yet: this just exposes
// the number.
if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    jsonResponse(['error' => 'method not allowed'], 405);
    exit;
}

jsonResponse([
    'protocol_version' => PROTOCOL_VERSION,
]);
