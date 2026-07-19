<?php
declare(strict_types=1);

// Pushover notification for a stalled plan-quiet thread (see
// checkPlanQuietWakes() in db.php). Mirrors RedditWatch's Pushover client
// (redditwatch/src/Pushover.php) but trimmed to this relay's plain-PHP,
// no-dependency style (deploy.php: "no composer/vendor, no build step") --
// one best-effort function instead of a retrying class. Token/user are never
// hardcoded: they live in privateDir()/pushover.config.php, the same
// outside-web-root convention auth.php already uses for auth.config.php, so
// a redeploy (deploy.php's FTPS mirror only ever touches the web-root
// remote_path) never ships or clobbers them.

const PUSHOVER_ENDPOINT = 'https://api.pushover.net/1/messages.json';

// Reads privateDir()/pushover.config.php -- copy pushover.config.example.php
// there and fill in the real app token + user key from pushover.net. Returns
// null (not an error) when the file is absent or incomplete, so a relay
// running without Pushover configured still works, it just never notifies.
function pushoverConfig(): ?array
{
    static $config = null;
    static $loaded = false;
    if ($loaded) {
        return $config;
    }
    $loaded = true;

    $configFile = privateDir() . '/pushover.config.php';
    if (!is_file($configFile)) {
        return null;
    }

    $data = require $configFile;
    if (!is_array($data) || empty($data['token']) || empty($data['user'])) {
        return null;
    }

    $config = ['token' => (string) $data['token'], 'user' => (string) $data['user']];
    return $config;
}

// Best-effort send -- any failure (not configured, network error, bad token)
// is logged to privateDir()/pushover.log and swallowed, never thrown, so a
// notification hiccup can never break the jobs.php poll loop that triggers
// this via checkPlanQuietWakes().
function sendPushoverNotification(string $title, string $message): void
{
    $config = pushoverConfig();
    if ($config === null) {
        return;
    }

    $fields = [
        'token' => $config['token'],
        'user' => $config['user'],
        'title' => $title,
        'message' => $message,
    ];

    $ch = curl_init(PUSHOVER_ENDPOINT);
    if ($ch === false) {
        return;
    }
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => http_build_query($fields),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 10,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_NOSIGNAL => true,
    ]);
    $body = curl_exec($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    if ($body === false || $status !== 200) {
        @file_put_contents(
            privateDir() . '/pushover.log',
            sprintf(
                "[%s] FAILED status=%d error=%s body=%s\n",
                isoNow(),
                $status,
                $error,
                is_string($body) ? $body : ''
            ),
            FILE_APPEND | LOCK_EX
        );
    }
}
