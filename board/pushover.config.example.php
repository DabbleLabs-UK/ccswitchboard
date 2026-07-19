<?php
declare(strict_types=1);

// Copy this file to privateDir()/pushover.config.php -- the same
// outside-web-root directory db.php's privateDir() already uses for
// jobs.sqlite and auth.php's auth.config.php (local dev: repo-root data/;
// prod: /home/dabblela/private/ccswitchboard/data, set via CCSW_DB_PATH) --
// and fill in real values from your pushover.net dashboard (an Application's
// API token, and your account's User Key). Do not commit the filled-in
// file. deploy.php's dist/ build never includes privateDir(), so this
// survives every redeploy untouched, same as auth.config.php.
return [
    'token' => '',
    'user' => '',
];
