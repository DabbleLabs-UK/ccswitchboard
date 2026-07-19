# ccswitchboard M1 relay

Plain PHP + SQLite job-queue API. No framework. Proves the round trip:
submit a job, poll for it, report a result.

## Auth (grace mode)

Every endpoint calls `requireAuth()` (see `auth.php`). It checks an
`X-CCSW-Token` header against a shared secret auto-generated into
`auth.config.php` in the private dir (see below) on first use.

Currently `AUTH_ENFORCE` in `auth.php` is `false` (grace mode): requests
without a valid token still succeed, but get logged to `auth.log` in the
private dir (timestamp, endpoint, IP, reason, user-agent). Once that log
shows no more tokenless traffic, flip `AUTH_ENFORCE` to `true` to start
rejecting tokenless/bad-token requests with 401.

## Endpoints

- `POST /job.php` - body `{"payload": ...}` -> `{"id": 1}`
- `GET /poll.php` - oldest pending job, atomically flipped to `running` -> `{"id": 1, "payload": ...}` or `{"job": null}`
- `POST /result.php` - body `{"id": 1, "result": ...}` -> `{"ok": true}` (this is how an agent reports a completed job)
- `GET /result.php?id=1` - current status of a job -> `{"id": 1, "status": "pending"|"running"|"done", "result": ...|null}` (this is how a consumer polls for a job's outcome; added for the browser extension's E3 wake loop)
- `GET /jobs.php?status=done&limit=50` - the `limit` (default 50, max 200) most recent jobs matching `status` (default `done`), oldest-first -> `{"jobs": [{"id": 1, "status": "done", "result": ..., "updated_at": "..."}]}` (this is how a consumer discovers newly-finished jobs without polling each id individually; added for the popup app)

The SQLite file lives in `data/jobs.sqlite`, created on first run. The `data/`
directory has a `.htaccess` denying all web access to it. In prod this same
directory (see `privateDir()` in `db.php`) also holds `auth.config.php` and
`auth.log`, outside the web root so redeploys never touch them.

## Running locally

    php -S localhost:8000

## Test the full loop with curl

    # 1. Submit a job
    curl -X POST http://localhost:8000/job.php -d '{"payload":"hello world"}'
    # => {"id":1}

    # 2. Poll for the oldest pending job (flips it to running)
    curl http://localhost:8000/poll.php
    # => {"id":1,"payload":"hello world"}

    # 3. Report the result
    curl -X POST http://localhost:8000/result.php -d '{"id":1,"result":"done processing"}'
    # => {"ok":true}
