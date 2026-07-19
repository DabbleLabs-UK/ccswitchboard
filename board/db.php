<?php
declare(strict_types=1);

// Relay protocol version -- the stable HTTP contract shared by every
// component that talks to this relay: the agent (CcswAgent), the browser
// extension, CcswPopup, and the Claude Usage desktop app (CU). Covers the
// shape of job payloads (job.php's dispatch body; jobs.php/status.php/
// poll.php's response fields), the set of endpoint verbs and what each
// expects/returns, and the wake/result formats (poll.php's flip-to-running
// response, result.php's completion body, wake.php/plan_wake.php's
// pop-and-delete payloads).
//
// Bump this only for a BREAKING change to that contract -- one where an
// older component would misinterpret or fail to parse a newer relay's
// request/response, or vice versa (e.g. renaming/removing a field a
// component depends on, changing an endpoint's verb or required params, or
// changing the meaning of an existing status/result value). Additive,
// backwards-compatible changes (a new optional field, a new endpoint, a new
// status value an older component can safely ignore) do NOT need a bump.
//
// Read via version.php ({"protocol_version": PROTOCOL_VERSION}). Not yet
// enforced anywhere -- no component currently checks it, and the relay
// doesn't reject mismatched callers. This just establishes the number ahead
// of that enforcement.
const PROTOCOL_VERSION = 1;

require_once __DIR__ . '/pushover.php';

// The private per-deployment directory: outside the web root in prod
// (/home/dabblela/private/ccswitchboard/data, set via .htaccess SetEnv
// CCSW_DB_PATH) while local dev keeps using the repo-root data/ directory
// (one level up from this file's own board/ subdir -- see dirname(__DIR__)
// below). Deploy's FTPS mirror only ever touches the web-root remote_path,
// so anything stored here (the SQLite file, the auth token config, the auth
// log) survives redeploys untouched -- same trick jobs.sqlite already relies
// on, reused by auth.php for the token config/log.
function privateDir(): string
{
    $dbPath = getenv('CCSW_DB_PATH') ?: (dirname(__DIR__) . '/data/jobs.sqlite');
    $dir = dirname($dbPath);
    if (!is_dir($dir)) {
        mkdir($dir, 0775, true);
    }
    return $dir;
}

function getDb(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $dbPath = getenv('CCSW_DB_PATH') ?: (dirname(__DIR__) . '/data/jobs.sqlite');
    privateDir();

    $pdo = new PDO('sqlite:' . $dbPath);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec('PRAGMA busy_timeout = 5000');
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            payload TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT \'pending\',
            result TEXT,
            thread TEXT,
            continue INTEGER NOT NULL DEFAULT 0,
            name TEXT,
            summary TEXT,
            stable_key TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )'
    );

    // Migrate pre-existing databases that predate the thread/continue/name columns.
    $columns = $pdo->query('PRAGMA table_info(jobs)')->fetchAll(PDO::FETCH_COLUMN, 1);
    if (!in_array('thread', $columns, true)) {
        $pdo->exec('ALTER TABLE jobs ADD COLUMN thread TEXT');
    }
    if (!in_array('continue', $columns, true)) {
        $pdo->exec('ALTER TABLE jobs ADD COLUMN continue INTEGER NOT NULL DEFAULT 0');
    }
    if (!in_array('name', $columns, true)) {
        $pdo->exec('ALTER TABLE jobs ADD COLUMN name TEXT');
    }
    if (!in_array('summary', $columns, true)) {
        $pdo->exec('ALTER TABLE jobs ADD COLUMN summary TEXT');
    }
    if (!in_array('cancel_requested', $columns, true)) {
        $pdo->exec('ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0');
    }
    if (!in_array('final', $columns, true)) {
        $pdo->exec('ALTER TABLE jobs ADD COLUMN final INTEGER NOT NULL DEFAULT 0');
    }
    if (!in_array('machine', $columns, true)) {
        $pdo->exec('ALTER TABLE jobs ADD COLUMN machine TEXT');
    }
    if (!in_array('started_at', $columns, true)) {
        // Set once by poll.php on the pending -> running flip and never
        // touched again -- unlike updated_at, which result.php overwrites on
        // completion, this survives as a stable "when did it actually start
        // running" marker even for a job that finishes between two client
        // polls (the common case for fast bash jobs).
        $pdo->exec('ALTER TABLE jobs ADD COLUMN started_at TEXT');
    }
    if (!in_array('delivery_pending', $columns, true)) {
        // Set/cleared by delivery.php, called from the browser extension's
        // send state machine (background.js) whenever a job's wake-prompt or
        // advice delivery enters/leaves its 'hold' phase. Mirrors the
        // extension's own client-side ccsw-job-bar--waiting flag so the
        // relay-rendered board (index.php) and the extension's own SW menu
        // can both show the same "held for delivery" indicator -- the board
        // has no other way to see this, since it's a different origin the
        // content script never runs on.
        $pdo->exec('ALTER TABLE jobs ADD COLUMN delivery_pending INTEGER NOT NULL DEFAULT 0');
    }
    if (!in_array('delivered_at', $columns, true)) {
        // Set once by delivery.php when the browser extension's send state
        // machine (background.js) CONFIRMS a job's wake-prompt actually landed
        // in chat (typed, send clicked, input verified cleared) -- see note
        // 448's ACK+RETRY layer. NULL means "done but not yet confirmed
        // delivered": the extension's result-watcher treats that as still
        // needing delivery and keeps re-offering it on every poll, even across
        // a service-worker restart that wiped its own in-memory state, since
        // this column -- not local chrome.storage.local -- is the durable
        // source of truth both sides trust.
        $pdo->exec('ALTER TABLE jobs ADD COLUMN delivered_at TEXT');
    }
    if (!in_array('nudged_at', $columns, true)) {
        // LAST-nudged timestamp, set by checkUndeliveredResults() each time it
        // (re-)nudges a thread about this job -- distinct from delivered_at,
        // which the extension itself confirms. A done job can sit with
        // delivered_at still NULL indefinitely (tab closed, thread gone);
        // without this column the sweep would re-wake the same thread on every
        // tick. It now paces the re-nudges to one per UNDELIVERED_NUDGE_SECONDS
        // (see checkUndeliveredResults) rather than capping at a single nudge
        // ever, so a persistently-undelivered result keeps getting re-offered
        // until it actually delivers.
        $pdo->exec('ALTER TABLE jobs ADD COLUMN nudged_at TEXT');
    }
    if (!in_array('outcome', $columns, true)) {
        $pdo->exec('ALTER TABLE jobs ADD COLUMN outcome TEXT');
        // One-time backfill: classify every already-finished job. Runs once
        // (guarded by the column-absent check). classifyJobResult expects the
        // decoded result value, matching how thread_states.php calls it.
        $doneRows = $pdo->query("SELECT id, result FROM jobs WHERE status = 'done'")->fetchAll(PDO::FETCH_ASSOC);
        $backfill = $pdo->prepare('UPDATE jobs SET outcome = :outcome WHERE id = :id');
        foreach ($doneRows as $r) {
            $decoded = $r['result'] !== null ? json_decode($r['result'], true) : null;
            $backfill->execute(['outcome' => classifyJobResult($decoded), 'id' => (int) $r['id']]);
        }
    }

    if (!in_array('stable_key', $columns, true)) {
        // The block-identity (browser-extension content.js's
        // fingerprintBlockStable) that produced this job, recorded by job.php
        // when a dispatch carries one. Nullable and never backfilled: rows
        // predating this column, and jobs dispatched by anything other than
        // the extension (CcswPopup, a manual board dispatch), simply have no
        // block identity to record.
        //
        // This is the durable half of the send-guard: a stableKey present in
        // this column means that exact block ALREADY dispatched, on any tab,
        // surviving the service-worker restarts and tab closes that used to
        // wipe the extension's in-memory guard and let a block re-fire. See
        // dispatched.php, which serves the per-thread key set back to the
        // client.
        $pdo->exec('ALTER TABLE jobs ADD COLUMN stable_key TEXT');
    }

    if (!in_array('dispatch_bucket', $columns, true)) {
        // #84 (threadless-block triple-dispatch): the browser extension's
        // resolved rule-(a) dedup bucket (content.js's resolveDedupBucket),
        // recorded ALONGSIDE `thread` rather than folded into it -- `thread`
        // keeps meaning exactly what it always has (job routing, locks, the
        // board's thread grouping), untouched by this column.
        //
        // For a block with an explicit `thread`, dispatch_bucket is written as
        // that SAME value -- redundant with `thread` on purpose, so
        // dispatched.php's existing `thread = ?` match already covers it and a
        // threaded block's dedup behaviour is byte-identical to before this
        // column existed. Only a threadless block's dispatch_bucket actually
        // differs from `thread` (the conversation's URL identity vs. NULL),
        // which is the case this column exists to fix: every tab open on that
        // conversation now writes/reads the same bucket instead of each tab's
        // own divergent hydrated thread name.
        //
        // NULL for rows from any dispatcher that doesn't send it (older
        // extension builds, CcswPopup, a manual board dispatch) -- dispatched.php
        // falls back to matching on `thread` for those, so nothing regresses.
        $pdo->exec('ALTER TABLE jobs ADD COLUMN dispatch_bucket TEXT');
    }

    if (!in_array('target', $columns, true)) {
        // M1 multi-machine targeting: which machine this job is FOR, chosen at
        // DISPATCH time (job.php, from payload.machine). Distinct from `machine`
        // above, which poll.php stamps at CLAIM time to record who actually took
        // it: target is the request, machine is the answer. poll.php only ever
        // hands a job to an agent polling with a matching ?machine=, so the two
        // agree for every job claimed after this column landed.
        //
        // NOT NULL DEFAULT 'vm' does double duty -- it backfills every
        // pre-existing row to 'vm' in this same statement, and it makes 'vm' the
        // standing default for any dispatcher that sends no machine (the browser
        // extension, CcswPopup, a manual board dispatch). Both keep landing on
        // the VM exactly as they did before targeting existed.
        $pdo->exec("ALTER TABLE jobs ADD COLUMN target TEXT NOT NULL DEFAULT 'vm'");
    }

    // Indexes for the permanent job store. status: pending/running/stale
    // filtering (poll + board). thread: per-thread lookups (thread_states,
    // sessions joins). created_at/updated_at: reaper time-range scans + the
    // board's age-window filters. IF NOT EXISTS = idempotent, safe per-connection.
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_jobs_thread ON jobs(thread)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_jobs_updated_at ON jobs(updated_at)');
    // Composite, not a bare stable_key index: the only query against this
    // column is dispatched.php's "which block identities have dispatched for
    // THIS bucket" (WHERE (thread = ? OR dispatch_bucket = ?) AND stable_key
    // IS NOT NULL), which these two composite indexes cover outright -- no row
    // lookups at all for either half of the OR.
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_jobs_thread_stable_key ON jobs(thread, stable_key)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_jobs_dispatch_bucket_stable_key ON jobs(dispatch_bucket, stable_key)');
    // poll.php's handout query is the hottest read on this table -- every agent,
    // every poll: WHERE status = 'pending' AND target = ? ORDER BY id ASC LIMIT 1.
    // This composite covers the filter outright, and since id is the rowid,
    // entries within a (status, target) group are already in id order -- so the
    // LIMIT 1 is an index seek with no sort step and no table scan.
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_jobs_status_target ON jobs(status, target)');

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS threads (
            thread TEXT PRIMARY KEY,
            tab_id INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        )'
    );

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS focus_requests (
            thread TEXT PRIMARY KEY,
            requested_at TEXT NOT NULL
        )'
    );

    // One row per thread recording when a real USER-authored send last landed
    // in that thread's chat (beacon.php, posted by the browser extension).
    // The durable other half of the eligibility rule that replaces the
    // extension's per-tab in-memory send-guard: a block dispatches iff its
    // stableKey is not already in jobs.stable_key AND a recent beacon exists
    // for its thread. "Recent" is the CLIENT's judgement -- this table only
    // stores the timestamps and never expires a row, so a thread's last send
    // is always answerable however long ago it was.
    //
    // sent_at is client wall-clock epoch MILLISECONDS (Date.now()), which is
    // what the extension has to hand; received_at is the relay's own ISO
    // stamp for the same event, so a skewed or reset client clock can still
    // be spotted (and, later, compared against) from the server side.
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS beacon (
            thread TEXT PRIMARY KEY,
            sent_at INTEGER NOT NULL,
            received_at TEXT NOT NULL
        )'
    );

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS locks (
            repo TEXT PRIMARY KEY,
            thread TEXT,
            job_id INTEGER NOT NULL,
            locked_at TEXT NOT NULL
        )'
    );

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS waiters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            repo TEXT NOT NULL,
            thread TEXT NOT NULL,
            requested_at TEXT NOT NULL,
            UNIQUE(repo, thread)
        )'
    );

    // Jobs dropped (409) because a repo they wanted was locked -- unlike
    // waiters above, this is NOT deduped/latest-wins and deliberately does
    // NOT skip the requesting thread on wake: a waiter queues a thread to be
    // woken by a DIFFERENT thread's release (self-release is always a real
    // in-flight result, see releaseLockAndWake's doc comment), but a drop
    // means nothing was ever queued or dispatched -- the same thread that
    // got dropped is exactly who needs to be told the repo is free again, so
    // it can reassess and manually re-fire. See job.php (insert on drop) and
    // releaseLockAndWake below (surfaces these as wakes on repo release).
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS pending_refires (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            repo TEXT NOT NULL,
            thread TEXT,
            payload TEXT NOT NULL,
            dropped_at TEXT NOT NULL
        )'
    );

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS wakes (
            thread TEXT NOT NULL,
            repo TEXT NOT NULL,
            requested_at TEXT NOT NULL,
            claimed_at TEXT,
            PRIMARY KEY (thread, repo)
        )'
    );

    // Migrate pre-existing databases whose wakes table predates the
    // claimed_at column (ack-based delivery, see wake.php).
    $wakeColumns = $pdo->query('PRAGMA table_info(wakes)')->fetchAll(PDO::FETCH_COLUMN, 1);
    if (!in_array('claimed_at', $wakeColumns, true)) {
        $pdo->exec('ALTER TABLE wakes ADD COLUMN claimed_at TEXT');
    }

    // Migrate pre-existing databases whose wakes table used a single-column
    // PK (thread only). That let a second repo's wake silently clobber the
    // first: releaseLockAndWake's ON CONFLICT(thread) upsert overwrote it at
    // INSERT time, and wake.php's ack DELETE WHERE thread = :thread wiped
    // every repo's wake for that thread the moment ANY one of them got acked
    // -- the cause of wakes vanishing when a thread queued for two repos at
    // once. Rebuilds under the (thread, repo) composite key, same
    // rename-and-rebuild approach as the sessions table migration above.
    $wakePkColumns = $pdo->query('PRAGMA table_info(wakes)')->fetchAll(PDO::FETCH_ASSOC);
    $wakeThreadIsSoleKey = false;
    foreach ($wakePkColumns as $col) {
        if ($col['name'] === 'thread' && (int) $col['pk'] === 1) {
            $wakeThreadIsSoleKey = true;
        }
        if ($col['name'] === 'repo' && (int) $col['pk'] > 0) {
            $wakeThreadIsSoleKey = false;
            break;
        }
    }
    if ($wakeThreadIsSoleKey) {
        $pdo->exec('BEGIN IMMEDIATE');
        try {
            $pdo->exec('ALTER TABLE wakes RENAME TO wakes_old');
            $pdo->exec(
                'CREATE TABLE wakes (
                    thread TEXT NOT NULL,
                    repo TEXT NOT NULL,
                    requested_at TEXT NOT NULL,
                    claimed_at TEXT,
                    PRIMARY KEY (thread, repo)
                )'
            );
            $pdo->exec(
                'INSERT INTO wakes (thread, repo, requested_at, claimed_at)
                 SELECT thread, repo, requested_at, claimed_at FROM wakes_old'
            );
            $pdo->exec('DROP TABLE wakes_old');
            $pdo->exec('COMMIT');
        } catch (Throwable $e) {
            $pdo->exec('ROLLBACK');
            throw $e;
        }
    }

    // M3: plan-quiet tracking. One row per thread with an "open" plan (see
    // plan.php) -- plan is the JSON-encoded string[] last rendered as pills
    // (browser-extension/content.js's renderPlanPills), updated_at is that
    // thread's last known activity (plan re-sent, job dispatched, or job
    // finished -- see bumpPlanActivity below), and nudged_at marks whether
    // checkPlanQuietWakes() already fired a nudge for the CURRENT quiet
    // period (cleared back to NULL on any new activity, so a resolved nudge
    // doesn't block a later one).
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS plans (
            thread TEXT PRIMARY KEY,
            plan TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            nudged_at TEXT
        )'
    );

    // One-shot pop-and-delete queue for plan-quiet nudges, mirroring wakes
    // above -- plan_wake.php pops the oldest row the same way wake.php does.
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS plan_wakes (
            thread TEXT PRIMARY KEY,
            requested_at TEXT NOT NULL
        )'
    );

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS sessions (
            thread TEXT NOT NULL,
            repo TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT \'default\',
            machine TEXT NOT NULL DEFAULT \'vm\',
            session_id TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (thread, repo, label, machine)
        )'
    );

    // Migrate pre-existing databases whose sessions table predates the label
    // column -- SQLite can't ALTER a PRIMARY KEY in place, so this rebuilds the
    // table under the new (thread, repo, label) key and backfills every
    // existing row with label='default', preserving today's one-session-per-
    // thread+repo behaviour exactly for jobs that never specify a label.
    $sessionColumns = $pdo->query('PRAGMA table_info(sessions)')->fetchAll(PDO::FETCH_COLUMN, 1);
    if (!in_array('label', $sessionColumns, true)) {
        $pdo->exec('BEGIN IMMEDIATE');
        try {
            $pdo->exec('ALTER TABLE sessions RENAME TO sessions_old');
            $pdo->exec(
                'CREATE TABLE sessions (
                    thread TEXT NOT NULL,
                    repo TEXT NOT NULL,
                    label TEXT NOT NULL DEFAULT \'default\',
                    session_id TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (thread, repo, label)
                )'
            );
            $pdo->exec(
                "INSERT INTO sessions (thread, repo, label, session_id, updated_at)
                 SELECT thread, repo, 'default', session_id, updated_at FROM sessions_old"
            );
            $pdo->exec('DROP TABLE sessions_old');
            $pdo->exec('COMMIT');
        } catch (Throwable $e) {
            $pdo->exec('ROLLBACK');
            throw $e;
        }
    }

    // Migrate pre-existing databases whose sessions table predates the machine
    // column (M1 multi-machine targeting). A CC session id names a session file
    // on the box that created it, so it is only ever resumable THERE -- without
    // the machine in the key, a DELL job resuming a thread+repo would be handed
    // the VM's session id and fail (or, worse, silently resume the wrong
    // conversation). Same rename-and-rebuild approach as the label migration
    // above, since SQLite can't ALTER a PRIMARY KEY in place.
    //
    // Backfills every existing row to machine='vm': every session recorded
    // before this column existed was necessarily created on the VM, because it
    // was the only machine there was.
    $sessionColumns = $pdo->query('PRAGMA table_info(sessions)')->fetchAll(PDO::FETCH_COLUMN, 1);
    if (!in_array('machine', $sessionColumns, true)) {
        $pdo->exec('BEGIN IMMEDIATE');
        try {
            $pdo->exec('ALTER TABLE sessions RENAME TO sessions_old');
            $pdo->exec(
                'CREATE TABLE sessions (
                    thread TEXT NOT NULL,
                    repo TEXT NOT NULL,
                    label TEXT NOT NULL DEFAULT \'default\',
                    machine TEXT NOT NULL DEFAULT \'vm\',
                    session_id TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (thread, repo, label, machine)
                )'
            );
            $pdo->exec(
                "INSERT INTO sessions (thread, repo, label, machine, session_id, updated_at)
                 SELECT thread, repo, label, 'vm', session_id, updated_at FROM sessions_old"
            );
            $pdo->exec('DROP TABLE sessions_old');
            $pdo->exec('COMMIT');
        } catch (Throwable $e) {
            $pdo->exec('ROLLBACK');
            throw $e;
        }
    }

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS job_output (
            job_id INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            text TEXT NOT NULL,
            at TEXT NOT NULL,
            PRIMARY KEY (job_id, seq)
        )'
    );

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS heartbeats (
            machine TEXT PRIMARY KEY,
            updated_at TEXT NOT NULL
        )'
    );

    // Machines PROVISIONED through machines.php's Add-a-machine form (P1). One
    // row per machine that has been minted a token of its own, holding the
    // token so machine_installer.php can bake it into that machine's installer
    // script -- the relay never shows it anywhere else.
    //
    // This is NOT the fleet, and not the auth set:
    //   - heartbeats says which machines are ALIVE. A machine provisioned but
    //     never started has a row here and none there; the VM (which predates
    //     provisioning and uses the primary token) is the reverse. machines.php
    //     unions the two to get the real fleet.
    //   - auth.config.php's 'tokens' list is what requireAuth() actually
    //     ACCEPTS. A row here is the record of a mint; the config entry is the
    //     grant. addAuthToken()/removeAuthToken() (auth.php) keep them in step,
    //     config first -- see machines.php for the ordering rationale.
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS machines (
            machine TEXT PRIMARY KEY,
            token TEXT NOT NULL,
            created_at TEXT NOT NULL
        )'
    );

    // Single-row (id=1) marker for checkAgentOfflineAlert()'s Pushover
    // transition tracking -- alerted_at is NULL while the agent is online (or
    // hasn't yet been alerted on for the current offline period), and set the
    // moment the offline alert fires, so it only fires once per outage.
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS agent_alert_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            alerted_at TEXT
        )'
    );

    // Single-row (id=1) marker for runThrottledReapSweeps()'s throttle below --
    // last_run_at is the wall-clock time the reap sweeps last actually ran from
    // that call site, so a burst of calls inside REAP_SWEEP_THROTTLE_SECONDS of
    // each other only sweeps once.
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS reap_sweep_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            last_run_at TEXT
        )'
    );

    // Action List: a queue of manual actions for Jody to do himself (reload
    // extension, restart agent, run a manual check, etc.), authored by Claude
    // via the browser extension's persistent Action List pill
    // (browser-extension/content.js). Populated by actions.php from either an
    // `actions` field riding a normal ccsw job dispatch or a standalone
    // plan-only-style ccsw block -- same mechanism as the `plans` table
    // above, see background.js's ccsw-actions-add handler. Ticking an item
    // off in the extension's dialog just DELETEs its row (actions.php's
    // `clear` op) -- no changelog, a cleared item is gone.
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT NOT NULL,
            tier TEXT NOT NULL,
            thread TEXT,
            created_at TEXT NOT NULL
        )'
    );

    // Migrate pre-existing databases whose actions table predates the thread
    // column -- back when the action list was one GLOBAL list shared by every
    // chat thread, so an item added from one thread showed up in all of them.
    // Nullable and never backfilled: a NULL thread is exactly the untagged /
    // 'Global' bucket those pre-existing rows belong in, and it stays the
    // default for any caller that doesn't tag its adds.
    $actionColumns = $pdo->query('PRAGMA table_info(actions)')->fetchAll(PDO::FETCH_COLUMN, 1);
    if (!in_array('thread', $actionColumns, true)) {
        $pdo->exec('ALTER TABLE actions ADD COLUMN thread TEXT');
    }

    // Composite, not a bare thread index: every SELECT against this table is
    // actions.php's list query, which orders by id ASC -- so a (thread, id)
    // index serves both the per-thread filter and that ordering from the
    // index alone, with no sort step.
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_actions_thread_id ON actions(thread, id)');

    // Central debug log: a cross-tab event stream so Claude can read what the
    // extension is actually doing instead of Jody narrating screenshots. Each
    // content script only ever sees its OWN tab, so events funnel
    // content.js -> background.js (ring buffer, throttled) -> debuglog.php.
    // `build` carries content.js/background.js's CCSW_BUILD stamp, which is
    // what catches a stale tab still running a pre-reload copy of the script.
    // `detail` is a JSON blob (shape varies per event type -- held_decision
    // carries the HELD2-DBG fields, dispatch carries job id/name, etc.), kept
    // opaque here so a new event type never needs a migration.
    //
    // Rotating, not append-forever: debuglog.php trims to DEBUG_LOG_KEEP_ROWS
    // after each insert batch. This is a diagnostic tail, not an audit trail.
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS debug_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            build TEXT,
            thread TEXT,
            type TEXT NOT NULL,
            detail TEXT
        )'
    );
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_debug_log_id ON debug_log(id)');
    $pdo->exec('CREATE INDEX IF NOT EXISTS idx_debug_log_type ON debug_log(type)');

    return $pdo;
}

function isoNow(): string
{
    return gmdate('Y-m-d\TH:i:s\Z');
}

// Releases ALL repo locks (if any) held by a job that just finished -- by
// completing normally or by being cancelled -- and wakes the longest-waiting
// thread for each of those repos, if one is queued. Shared by result.php and
// cancel.php so both finalization paths release the lock(s) the same way. A
// job holds more than one lock row when it was dispatched with a 'locks'
// array (see job.php) -- one row per locked repo, all sharing this job_id --
// so this releases and wakes per-repo across every row, not just one.
//
// Never wakes the SAME thread whose job just finished. A thread that
// dispatches a follow-up job for a repo its OWN still-running job already
// holds gets queued as a waiter for itself (job.php doesn't special-case
// this), but that thread is about to receive this job's actual result via
// result.php's own per-job delivery -- a "repo is now free" nudge racing
// against that real result either duplicates it or (per the bug this
// guards against) wins the race and the real result never gets pasted.
// Self-waiters are simply dropped here; a genuinely different waiting
// thread (if any) is woken instead.
function releaseLockAndWake(PDO $pdo, int $jobId, string $now): void
{
    $lockStmt = $pdo->prepare('SELECT repo, thread FROM locks WHERE job_id = :id');
    $lockStmt->execute(['id' => $jobId]);
    $locks = $lockStmt->fetchAll(PDO::FETCH_ASSOC);

    if ($locks === []) {
        return;
    }

    $releaseStmt = $pdo->prepare('DELETE FROM locks WHERE job_id = :id');
    $releaseStmt->execute(['id' => $jobId]);

    foreach ($locks as $lock) {
        wakeNextWaiter($pdo, $lock['repo'], $lock['thread'], $now);
        wakePendingRefires($pdo, $lock['repo'], $now);
    }
}

// Surfaces every job previously dropped (409, repo locked -- see job.php)
// for $repo now that its lock is free, by waking each dropped job's own
// thread. Deliberately does NOT skip the thread whose release just freed
// $repo (unlike wakeNextWaiter's $finishedThread skip above) -- a drop never
// queued or dispatched anything, so the thread that got dropped is exactly
// who needs telling "repo free, reassess and re-fire" even if it's the same
// thread that just finished the job that held the lock. Nothing here
// re-dispatches the dropped job automatically; the wake is just a nudge.
function wakePendingRefires(PDO $pdo, string $repo, string $now): void
{
    $stmt = $pdo->prepare('SELECT id, thread FROM pending_refires WHERE repo = :repo');
    $stmt->execute(['repo' => $repo]);
    $pending = $stmt->fetchAll(PDO::FETCH_ASSOC);

    foreach ($pending as $row) {
        // A null thread means the original drop carried no thread to route a
        // wake back to (job.php only records a waiter/refire thread when the
        // request included one) -- there's nowhere to deliver a wake, so this
        // just clears the row rather than leaving it stuck forever.
        if ($row['thread'] !== null) {
            $wakeStmt = $pdo->prepare(
                'INSERT INTO wakes (thread, repo, requested_at, claimed_at) VALUES (:thread, :repo, :now, NULL)
                 ON CONFLICT(thread, repo) DO UPDATE SET requested_at = excluded.requested_at, claimed_at = NULL'
            );
            $wakeStmt->execute(['thread' => $row['thread'], 'repo' => $repo, 'now' => $now]);
        }

        $delStmt = $pdo->prepare('DELETE FROM pending_refires WHERE id = :id');
        $delStmt->execute(['id' => $row['id']]);
    }
}

// Pops and wakes the longest-waiting thread queued for $repo (if any) --
// the per-repo body shared by releaseLockAndWake above and releaseRepoLock
// below. $finishedThread is the thread whose lock on $repo just ended (or
// null), never re-woken for its own release, per releaseLockAndWake's own
// doc comment.
function wakeNextWaiter(PDO $pdo, string $repo, ?string $finishedThread, string $now): void
{
    while (true) {
        $waiterStmt = $pdo->prepare('SELECT id, thread FROM waiters WHERE repo = :repo ORDER BY requested_at ASC LIMIT 1');
        $waiterStmt->execute(['repo' => $repo]);
        $waiter = $waiterStmt->fetch(PDO::FETCH_ASSOC);

        if ($waiter === false) {
            break;
        }

        $delStmt = $pdo->prepare('DELETE FROM waiters WHERE id = :id');
        $delStmt->execute(['id' => $waiter['id']]);

        if ($finishedThread !== null && $waiter['thread'] === $finishedThread) {
            continue;
        }

        $wakeStmt = $pdo->prepare(
            'INSERT INTO wakes (thread, repo, requested_at, claimed_at) VALUES (:thread, :repo, :now, NULL)
             ON CONFLICT(thread, repo) DO UPDATE SET requested_at = excluded.requested_at, claimed_at = NULL'
        );
        $wakeStmt->execute(['thread' => $waiter['thread'], 'repo' => $repo, 'now' => $now]);
        break;
    }
}

// Manual/admin release of a single repo's lock, independent of the job_id
// that took it -- for the board's Manual Controls panel (clear_lock.php,
// clear_locks.php), used to unstick a repo whose owning job will never post
// a result (e.g. after a hand-restarted agent orphaned it). Deletes just
// that repo's lock row and wakes its next waiter, same as a normal
// completion would, without touching any OTHER repo the same job_id might
// also hold (see job.php's payload.locks / lock_repo, which can lock several
// repos under one job_id) -- an admin clearing one stuck repo shouldn't also
// drop locks on repos that are still genuinely in use.
// Returns false if no lock was held for $repo.
function releaseRepoLock(PDO $pdo, string $repo, string $now): bool
{
    $lockStmt = $pdo->prepare('SELECT thread FROM locks WHERE repo = :repo');
    $lockStmt->execute(['repo' => $repo]);
    $lock = $lockStmt->fetch(PDO::FETCH_ASSOC);

    if ($lock === false) {
        return false;
    }

    $pdo->prepare('DELETE FROM locks WHERE repo = :repo')->execute(['repo' => $repo]);
    wakeNextWaiter($pdo, $repo, $lock['thread'], $now);

    return true;
}

// How long a thread's open plan (plans table) can sit with no running/
// pending job before checkPlanQuietWakes() below fires a one-shot nudge
// asking Claude to reassess and continue -- never re-asserts a specific
// step, just prompts a fresh look. Piggybacks on the same cheap-GET-poll
// cadence as reapDeadJobs/reapStalePendingJobs (called from jobs.php).
const PLAN_QUIET_THRESHOLD_SECONDS = 120;

// How long a 'done' job can sit with delivered_at still NULL before
// checkUndeliveredResults() below concludes the extension never delivered
// its result (tab closed, thread gone, service worker restart that dropped
// the queued send) and nudges the thread directly instead. Deliberately
// short relative to PLAN_QUIET_THRESHOLD_SECONDS -- an undelivered result is
// a stuck queue right now, not a "gone quiet" judgement call.
const UNDELIVERED_NUDGE_SECONDS = 150;

// How long a claimed-but-unacked wake (wake.php GET) is withheld from being
// re-offered on a later poll -- long enough to cover a legitimate in-flight
// delivery's worst case, so a second tab doesn't get handed the same wake
// while the first is still genuinely working on it. background.js's send
// state machine can hold a delivery in phase 'hold' for up to
// SEND_HOLD_TIMEOUT_MS (5 minutes) before giving up, so this matches that.
// Only wake.php's POST ack path (confirmed sent, see background.js's
// finishSend/ackWake) deletes a wake before this window elapses; anything
// else (failed delivery, tab closed mid-send, service worker restart that
// wiped pendingSends) just leaves it claimed until this expires, at which
// point it's offered again instead of being lost.
const WAKE_CLAIM_DEBOUNCE_SECONDS = 300;

// A pending job a live agent would have grabbed well within this window --
// past it, there's no evidence any agent is polling at all.
const STALE_PENDING_AFTER_SECONDS = 60;

// How long a stale job is allowed to auto-resume once the agent's heartbeat
// reappears. Past this, it's assumed the delay was long enough that the
// queued work may no longer be wanted as-is, so it waits for a manual Resume
// click instead of firing off on its own.
const STALE_RESUME_CUTOFF_SECONDS = 600;

// Marks 'pending' jobs that have waited too long without a worker grabbing
// them as 'stale' -- the poll.php loop only leaves a job pending this long
// when no agent is currently alive to dequeue it. Piggybacks on the same
// cheap-GET-poll cadence as reapDeadJobs (see below); resumeStaleJobs() is
// the other half, run from heartbeat.php when an agent reconnects.
function reapStalePendingJobs(PDO $pdo): void
{
    $cutoff = gmdate('Y-m-d\TH:i:s\Z', time() - STALE_PENDING_AFTER_SECONDS);

    $pdo->exec('BEGIN IMMEDIATE');
    try {
        // M1 multi-machine targeting: only ever stale a job whose TARGET machine
        // has a heartbeat row -- i.e. one whose agent this relay has heard from
        // at least once, ever. Staleness means "an agent should have grabbed
        // this by now and didn't", which is only a meaningful claim about a
        // machine that has an agent at all. A job targeted at a machine with no
        // heartbeat row whatsoever is queued for a box whose agent isn't
        // installed yet -- a normal, expected state on the way to bringing a new
        // machine online, not an error -- so it stays pending untouched until
        // that agent first appears, rather than being staled 60s after dispatch
        // and needing a manual Resume. Behaviour for 'vm' is unchanged: it has
        // heartbeated for as long as the table has existed, so its pending jobs
        // still stale exactly as before.
        $stmt = $pdo->prepare(
            "UPDATE jobs SET status = 'stale', updated_at = :now
             WHERE status = 'pending' AND created_at < :cutoff
               AND EXISTS (SELECT 1 FROM heartbeats WHERE heartbeats.machine = jobs.target)"
        );
        $stmt->execute(['now' => isoNow(), 'cutoff' => $cutoff]);
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
}

// Auto-resumes stale jobs still within the resume cutoff whenever a
// heartbeat comes in -- a reappearing heartbeat is the signal an agent is
// alive again to dequeue them. Jobs stale longer than the cutoff are left
// alone; resume.php's manual Resume button is the only way to bring those
// back, since the caller may not want them firing off unattended after such
// a long gap.
//
// $machine scopes the resume to jobs targeted at the machine whose heartbeat
// triggered it (heartbeat.php passes its own): DELL coming back online is no
// evidence at all that anything is alive to dequeue a VM-targeted job, so it
// must not flip VM's stale jobs back to pending -- they'd sit pending until
// staled again, churning status for a machine that is still dark. Null (the
// default) resumes every machine's stale jobs, preserving the old un-scoped
// behaviour for any caller that has no particular machine in hand.
function resumeStaleJobs(PDO $pdo, ?string $machine = null): void
{
    $cutoff = gmdate('Y-m-d\TH:i:s\Z', time() - STALE_RESUME_CUTOFF_SECONDS);

    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $sql = "UPDATE jobs SET status = 'pending', updated_at = :now WHERE status = 'stale' AND created_at >= :cutoff";
        $params = ['now' => isoNow(), 'cutoff' => $cutoff];
        if ($machine !== null && $machine !== '') {
            $sql .= ' AND target = :machine';
            $params['machine'] = $machine;
        }
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
}

// How long since the last heartbeat before the agent is considered offline --
// shared by reapDeadJobs' dead-job cutoff, isAgentOffline() (jobs.php's
// `agentOffline` field + the board/thread offline banners), and
// checkAgentOfflineAlert()'s Pushover trigger below, so all three surfaces
// agree on the same "is the agent actually there" answer.
const AGENT_OFFLINE_AFTER_SECONDS = 120;

// Mirrors AgentCore.cs's _silenceTimeout default and jobs.php's own
// silence_timeout fallback -- keep in sync if that changes. Used by
// reapWedgedJobs() below when a job's payload carries no override.
//
// MUST be >= AgentCore.cs's DefaultSilenceTimeoutSeconds. reapWedgedJobs()
// only reaps after max(this * WEDGED_REAP_MARGIN_MULTIPLIER, this +
// WEDGED_REAP_MARGIN_FLOOR_SECONDS), which is designed to land strictly
// after the agent's own silence timer -- but that only holds if this
// default is already >= the agent's. If this value ever drifts below the
// agent's DefaultSilenceTimeoutSeconds again, the relay will reap live,
// still-running jobs before the agent's own timer gets a chance to fire.
const DEFAULT_SILENCE_TIMEOUT_SECONDS = 300.0;

// reapWedgedJobs() below reaps a 'running' job once it has gone silent
// (jobs.updated_at, bumped by append.php on every output chunk) for longer
// than its own silence-timeout window times this multiplier, floored at the
// window plus this many seconds. The agent's own silence timer (AgentCore.cs)
// is the first line of defence for a wedged job; this margin exists so the
// relay only ever reaps AFTER that timer would legitimately have already
// fired -- never in front of it, which would kill a job the agent was still
// correctly running.
const WEDGED_REAP_MARGIN_MULTIPLIER = 1.5;
const WEDGED_REAP_MARGIN_FLOOR_SECONDS = 60;

// Reaps jobs left stuck 'running' by an agent that has gone dark -- no cron
// job exists in this project, so this piggybacks on jobs.php's cheap GET
// poll instead of running on its own schedule. A job whose machine has never
// sent a heartbeat (or has none recorded at all, e.g. an older row) is
// treated the same as a stale one: there's no evidence the agent is still
// alive, so it must not be left running forever either.
//
// The LEFT JOIN below is per-machine and always has been, which is exactly the
// property M1 multi-machine targeting needs: each running job is compared
// against the heartbeat of the machine that CLAIMED it (jobs.machine, stamped
// by poll.php), never against the newest heartbeat from any machine. So a dark
// VM's stale heartbeat reaps only the VM's jobs and leaves DELL's running work
// alone, and vice versa. Don't "simplify" this into a global MAX(updated_at)
// check against heartbeats -- that would make every machine's outage reap every
// other machine's live jobs.
function reapDeadJobs(PDO $pdo): void
{
    $cutoff = gmdate('Y-m-d\TH:i:s\Z', time() - AGENT_OFFLINE_AFTER_SECONDS);

    $pdo->exec('BEGIN IMMEDIATE');
    try {
        // LIVENESS OVERRIDE (19 Jul): a job that has produced output within the
        // cutoff window is PROOF its agent is alive, and outranks a stale
        // heartbeat every time. append.php bumps jobs.updated_at on every output
        // chunk, so this is a direct liveness signal from the job itself,
        // whereas the heartbeat is a signal about the TRANSPORT that carries it.
        //
        // Why this matters: the heartbeat is a single 30s POST from one loop in
        // the agent. If that loop stalls, dies, or just loses a couple of
        // requests to a flapping relay, every running job on that machine gets
        // killed with "ERROR: agent lost" while the agent is demonstrably fine
        // -- confirmed on 19 Jul, when the agent's heartbeat loop died silently
        // and the poll workers carried on working (fixed agent-side in
        // AgentCore.HeartbeatLoopAsync, but the reaper must not have been this
        // brittle in the first place). Destroying live work on the strength of
        // one unacknowledged HTTP request is not a trade worth making: the cost
        // of reaping late is a job sitting 'running' a bit longer, and the cost
        // of reaping wrongly is losing completed work outright.
        //
        // A genuinely dead agent produces no output either, so its jobs still
        // fall through to the heartbeat test below and are reaped as before --
        // and reapWedgedJobs remains the backstop for a job that goes silent
        // while its heartbeat stays fresh. The two now cover each other's blind
        // spots instead of sharing one.
        $staleStmt = $pdo->prepare(
            "SELECT jobs.id FROM jobs
             LEFT JOIN heartbeats ON heartbeats.machine = jobs.machine
             WHERE jobs.status = 'running'
               AND jobs.updated_at < :job_cutoff
               AND (jobs.machine IS NULL OR heartbeats.updated_at IS NULL OR heartbeats.updated_at < :hb_cutoff)"
        );
        // Two distinct placeholders for the same value on purpose: PDO_SQLITE
        // does not emulate prepares, so binding one named parameter to two
        // positions raises "Invalid parameter number" at execute time.
        $staleStmt->execute(['job_cutoff' => $cutoff, 'hb_cutoff' => $cutoff]);
        $deadIds = $staleStmt->fetchAll(PDO::FETCH_COLUMN);

        if ($deadIds === []) {
            $pdo->exec('COMMIT');
            return;
        }

        $now = isoNow();
        $updateStmt = $pdo->prepare(
            "UPDATE jobs SET status = 'done', result = :result, outcome = :outcome, updated_at = :now WHERE id = :id"
        );
        foreach ($deadIds as $id) {
            $updateStmt->execute([
                'result' => json_encode('ERROR: agent lost'),
                'outcome' => 'errored',
                'now' => $now,
                'id' => (int) $id,
            ]);
            releaseLockAndWake($pdo, (int) $id, $now);
        }

        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
}

// Backstop for a job stuck 'running' whose AGENT is still alive (heartbeat
// fresh, so reapDeadJobs above never touches it) but whose WORKER is WEDGED
// on this one job -- e.g. a hung CC prompt -- and never posts more output or
// a result. The agent's own silence timer (AgentCore.cs) is meant to catch
// this and post its own error result, but it doesn't always fire; this is
// the relay-side backstop for when it doesn't, so the job (and the repo lock
// it holds) doesn't sit stuck forever.
//
// append.php bumps jobs.updated_at on every streamed output chunk for a
// running job, so updated_at means "last real output time" here (unlike
// reapDeadJobs' heartbeat-based check). A running job is wedged once that
// has gone stale for longer than its own silence-timeout window (the job's
// payload.silence_timeout override, else DEFAULT_SILENCE_TIMEOUT_SECONDS)
// times WEDGED_REAP_MARGIN_MULTIPLIER, floored at the window plus
// WEDGED_REAP_MARGIN_FLOOR_SECONDS -- deliberately later than the agent's own
// timer would fire, so this never reaps a job the agent is still legitimately
// running. Piggybacks on the same cadence as reapDeadJobs (jobs.php's cheap
// GET poll, poll.php's throttled sweep, and tick.php's cron).
function reapWedgedJobs(PDO $pdo): void
{
    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $rowStmt = $pdo->query("SELECT id, payload, updated_at FROM jobs WHERE status = 'running'");
        $rows = $rowStmt->fetchAll(PDO::FETCH_ASSOC);

        if ($rows === []) {
            $pdo->exec('COMMIT');
            return;
        }

        $nowTs = time();
        $now = isoNow();
        $updateStmt = $pdo->prepare(
            "UPDATE jobs SET status = 'done', result = :result, outcome = :outcome, updated_at = :now WHERE id = :id"
        );

        foreach ($rows as $row) {
            $payload = json_decode((string) $row['payload'], true);
            $silenceTimeout = is_array($payload) && isset($payload['silence_timeout']) && $payload['silence_timeout'] > 0
                ? (float) $payload['silence_timeout']
                : DEFAULT_SILENCE_TIMEOUT_SECONDS;

            $window = max(
                $silenceTimeout * WEDGED_REAP_MARGIN_MULTIPLIER,
                $silenceTimeout + WEDGED_REAP_MARGIN_FLOOR_SECONDS
            );

            $updatedAtTs = strtotime((string) $row['updated_at']);
            $silentFor = $updatedAtTs !== false ? ($nowTs - $updatedAtTs) : PHP_INT_MAX;
            if ($silentFor < $window) {
                continue;
            }

            $updateStmt->execute([
                'result' => json_encode(sprintf('ERROR: job wedged (no output for %ds), reaped by relay', $silentFor)),
                'outcome' => 'errored',
                'now' => $now,
                'id' => (int) $row['id'],
            ]);
            releaseLockAndWake($pdo, (int) $row['id'], $now);
        }

        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
}

// Backstop for lock rows that outlive the job that held them. job.php,
// result.php, and cancel.php all release a job's lock(s) via
// releaseLockAndWake the moment that specific job finishes, and reapDeadJobs
// above does the same for jobs it reaps -- but reapDeadJobs only ever looks
// at status = 'running', so a lock whose job had already reached a terminal
// state by some other path (or whose job row is missing entirely) is never
// picked up by any of those and would otherwise sit locked forever, wedging
// every future dispatch for that repo behind a "repo busy" that can never
// clear. Piggybacks on jobs.php's cheap GET poll, same cadence as
// reapDeadJobs. Only sweeps locks whose job is genuinely terminal (status =
// 'done') or whose job_id has no matching row at all -- never one still
// 'pending', 'running', or 'stale', since those are legitimately still
// in-flight (or waiting to (re)start) and releasing early would let a second
// job grab the same repo out from under them.
function reapOrphanedLocks(PDO $pdo): void
{
    $now = isoNow();

    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $orphanStmt = $pdo->prepare(
            "SELECT DISTINCT locks.job_id FROM locks
             LEFT JOIN jobs ON jobs.id = locks.job_id
             WHERE jobs.id IS NULL OR jobs.status = 'done'"
        );
        $orphanStmt->execute();
        $jobIds = $orphanStmt->fetchAll(PDO::FETCH_COLUMN);

        foreach ($jobIds as $jobId) {
            releaseLockAndWake($pdo, (int) $jobId, $now);
        }

        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
}

// Resets a thread's plan-quiet timer -- called from job.php (job dispatched),
// result.php (job finished), and cancel.php (job cancelled) so any real queue
// activity for the thread postpones checkPlanQuietWakes() below. A no-op
// when the thread has no open plan (plans table has no row for it, e.g. it
// never sent one or already cleared it), which is the common case for most
// jobs -- this is cheap and safe to call unconditionally from those paths.
function bumpPlanActivity(PDO $pdo, ?string $thread, string $now): void
{
    if ($thread === null || $thread === '') {
        return;
    }

    $stmt = $pdo->prepare('UPDATE plans SET updated_at = :now, nudged_at = NULL WHERE thread = :thread');
    $stmt->execute(['now' => $now, 'thread' => $thread]);
}

// Fires a one-shot plan-quiet nudge (via plan_wakes, popped by plan_wake.php)
// for every thread whose open plan (plans table, set by plan.php) has gone
// quiet: no activity in PLAN_QUIET_THRESHOLD_SECONDS AND no pending/running
// job currently in flight for it AND not already nudged since its last
// activity. This never re-asserts a specific plan step or forces continuation
// -- it only asks Claude to look again and decide what's next (see
// background.js's pollPlanWake for the actual prompt text). Piggybacks on
// jobs.php's cheap GET poll, same as reapDeadJobs/reapStalePendingJobs above.
//
// Also fires a Pushover push per newly-quiet thread (see pushover.php), so
// Jody finds out a queue stalled even while away from the browser. Exactly
// once per quiet period: a thread only appears in $threads on the FIRST poll
// after it goes quiet, since nudged_at then blocks it from being reselected
// until bumpPlanActivity() clears it on the next real activity. Sent AFTER
// the transaction commits, never inside it -- it's a network call and must
// not hold the BEGIN IMMEDIATE lock.
function checkPlanQuietWakes(PDO $pdo): void
{
    $cutoff = gmdate('Y-m-d\TH:i:s\Z', time() - PLAN_QUIET_THRESHOLD_SECONDS);

    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $stmt = $pdo->prepare(
            "SELECT thread FROM plans
             WHERE updated_at < :cutoff
               AND nudged_at IS NULL
               AND NOT EXISTS (
                   SELECT 1 FROM jobs WHERE jobs.thread = plans.thread AND jobs.status IN ('pending', 'running')
               )"
        );
        $stmt->execute(['cutoff' => $cutoff]);
        $threads = $stmt->fetchAll(PDO::FETCH_COLUMN);

        if ($threads === []) {
            $pdo->exec('COMMIT');
            return;
        }

        $now = isoNow();
        $markStmt = $pdo->prepare('UPDATE plans SET nudged_at = :now WHERE thread = :thread');
        $wakeStmt = $pdo->prepare(
            'INSERT INTO plan_wakes (thread, requested_at) VALUES (:thread, :now)
             ON CONFLICT(thread) DO UPDATE SET requested_at = excluded.requested_at'
        );
        foreach ($threads as $thread) {
            $markStmt->execute(['now' => $now, 'thread' => $thread]);
            $wakeStmt->execute(['thread' => $thread, 'now' => $now]);
        }

        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }

    foreach ($threads as $thread) {
        sendPushoverNotification(
            'CCSW: plan stalled',
            "Thread \"{$thread}\" has gone quiet with an open plan and needs attention."
        );
    }
}

// Backstop for a 'done' job whose result the extension never delivered --
// delivered_at stays NULL forever if the thread's tab closed, the thread
// itself is gone, or a service-worker restart dropped the queued send before
// wake.php's ack path ever ran. Fires a per-job 'result-watchdog#<id>' wake
// (repo.php/wake.php's normal poll path, see background.js's pollWake) at the
// job's own thread; the wake carries the jobId so the extension can refetch
// and REDELIVER the actual result (background.js's redeliverUndeliveredResult),
// not just nudge Claude to go dig it up. Unlike wakePendingRefires (~line 530),
// the dispatching thread here IS the intended target -- there's no other-thread
// exclusion to apply.
//
// Bug A hardening -- three properties this backstop now guarantees:
//   1. RE-NUDGE while undelivered. nudged_at is a LAST-nudged timestamp, not a
//      permanent one-shot flag: a job that is still done+undelivered keeps
//      being re-armed once nudged_at ages past UNDELIVERED_NUDGE_SECONDS. A
//      lost result is nudged periodically until it actually delivers, rather
//      than going silent after a single generic nudge. The delivered_at IS NULL
//      guard closes the loop -- the moment the extension confirms delivery
//      (delivery.php sets delivered_at) the job drops out of this sweep for
//      good, so a genuinely delivered job is never re-nudged.
//   2. PER-JOB wakes. The wake is keyed by repo='result-watchdog#<id>', so N
//      undelivered jobs on one thread produce N distinct wakes rather than
//      collapsing (the old bare 'result-watchdog' key) into a single generic
//      one. Each undelivered result gets its own wake.
//   3. Carries the jobId (in that repo key) so recovery redelivers the ACTUAL
//      result for that job, not a generic "check the board" message.
// Exactly-once is preserved on the extension side: redelivery funnels through
// queueSend's already-delivered gate (isJobDelivered local ledger + this
// column via result.php's `delivered` flag), so repeat nudges and per-job
// redelivery can never double-deliver a job that already landed.
function checkUndeliveredResults(PDO $pdo): void
{
    $cutoff = gmdate('Y-m-d\TH:i:s\Z', time() - UNDELIVERED_NUDGE_SECONDS);

    $pdo->exec('BEGIN IMMEDIATE');
    try {
        // Re-arm a nudge for any still-undelivered done job whose last nudge
        // (if any) is older than UNDELIVERED_NUDGE_SECONDS. nudged_at IS NULL
        // -> never nudged (first nudge, gated by updated_at so the job has
        // actually been sitting undelivered); nudged_at <= cutoff -> due for a
        // repeat. Same cutoff for both keeps the spacing a steady
        // UNDELIVERED_NUDGE_SECONDS so a persistently-stuck job nudges
        // periodically, never every poll.
        $stmt = $pdo->prepare(
            "SELECT id, thread, name FROM jobs
             WHERE status = 'done'
               AND delivered_at IS NULL
               AND thread IS NOT NULL AND thread != ''
               AND updated_at <= :cutoff
               AND (nudged_at IS NULL OR nudged_at <= :cutoff)"
        );
        $stmt->execute(['cutoff' => $cutoff]);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        if ($rows === []) {
            $pdo->exec('COMMIT');
            return;
        }

        $now = isoNow();
        $wakeStmt = $pdo->prepare(
            'INSERT INTO wakes (thread, repo, requested_at, claimed_at) VALUES (:thread, :repo, :now, NULL)
             ON CONFLICT(thread, repo) DO UPDATE SET requested_at = excluded.requested_at, claimed_at = NULL'
        );
        $markStmt = $pdo->prepare('UPDATE jobs SET nudged_at = :now WHERE id = :id');

        foreach ($rows as $row) {
            // Per-job wake key -- carries the jobId so the extension redelivers
            // the actual result, and so two undelivered jobs on one thread
            // don't collapse onto a single (thread, repo) wake row.
            $repo = 'result-watchdog#' . (int) $row['id'];
            $wakeStmt->execute(['thread' => $row['thread'], 'repo' => $repo, 'now' => $now]);
            $markStmt->execute(['now' => $now, 'id' => (int) $row['id']]);
        }

        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }
}

// How far apart runThrottledReapSweeps() actually runs the sweeps below when
// called from poll.php -- the agent hits poll.php every 2s per worker
// regardless of whether the board is open, so running the full sweep set on
// every single poll would multiply their BEGIN IMMEDIATE writes ~15x with no
// benefit, since nothing meaningfully changes between polls that close
// together. jobs.php's browser-facing GET still runs the sweeps unthrottled
// on every load; this only guards the poll.php call site.
const REAP_SWEEP_THROTTLE_SECONDS = 30;

// Runs reapDeadJobs/reapWedgedJobs/reapOrphanedLocks/reapStalePendingJobs/
// checkPlanQuietWakes at most once per REAP_SWEEP_THROTTLE_SECONDS -- lets poll.php piggyback the
// same sweeps jobs.php already runs on its cheap GET, so orphaned locks and
// dead/stale jobs get cleaned up continuously via the agent's own polling
// instead of only while a board tab happens to be open.
//
// Every sweep below is machine-scoped by construction (M1 multi-machine
// targeting), which matters now that this runs from EVERY machine's poll:
// reapDeadJobs joins each running job to its OWN claiming machine's heartbeat,
// and reapStalePendingJobs only touches jobs whose target has a heartbeat row
// at all. So a sweep triggered by DELL's poll can never reap a job the VM is
// still legitimately running, and vice versa.
function runThrottledReapSweeps(PDO $pdo): void
{
    $pdo->exec('INSERT INTO reap_sweep_state (id, last_run_at) VALUES (1, NULL) ON CONFLICT(id) DO NOTHING');
    $row = $pdo->query('SELECT last_run_at FROM reap_sweep_state WHERE id = 1')->fetch(PDO::FETCH_ASSOC);
    $lastRun = $row !== false ? $row['last_run_at'] : null;

    if ($lastRun !== null && (time() - strtotime($lastRun)) < REAP_SWEEP_THROTTLE_SECONDS) {
        return;
    }

    $stmt = $pdo->prepare('UPDATE reap_sweep_state SET last_run_at = :now WHERE id = 1');
    $stmt->execute(['now' => isoNow()]);

    reapDeadJobs($pdo);
    reapWedgedJobs($pdo);
    reapOrphanedLocks($pdo);
    reapStalePendingJobs($pdo);
    checkPlanQuietWakes($pdo);
}

// True when no machine has sent a heartbeat within AGENT_OFFLINE_AFTER_SECONDS
// (or none ever has) -- the single definition of "agent offline" shared by
// jobs.php's `agentOffline` field (board banner + the extension's in-thread
// banner) and checkAgentOfflineAlert()'s Pushover trigger below.
function isAgentOffline(PDO $pdo): bool
{
    $row = $pdo->query('SELECT MAX(updated_at) AS latest FROM heartbeats')->fetch(PDO::FETCH_ASSOC);
    $latest = $row !== false ? $row['latest'] : null;
    return $latest === null || (time() - strtotime($latest)) >= AGENT_OFFLINE_AFTER_SECONDS;
}

// Fires a Pushover push the moment the agent's heartbeat FIRST goes stale
// (isAgentOffline() flips false -> true), not on every subsequent poll --
// agent_alert_state holds a single row whose alerted_at is set as soon as the
// alert fires and cleared as soon as the agent is seen online again, so the
// next offline period gets its own fresh alert. Piggybacks on the same
// cheap-GET-poll cadence as reapDeadJobs/reapStalePendingJobs/
// checkPlanQuietWakes above (called from jobs.php). Sent AFTER the
// transaction commits, never inside it, same reasoning as
// checkPlanQuietWakes.
function checkAgentOfflineAlert(PDO $pdo): void
{
    $offline = isAgentOffline($pdo);
    $shouldAlert = false;

    $pdo->exec('BEGIN IMMEDIATE');
    try {
        $pdo->exec('INSERT INTO agent_alert_state (id, alerted_at) VALUES (1, NULL) ON CONFLICT(id) DO NOTHING');
        $row = $pdo->query('SELECT alerted_at FROM agent_alert_state WHERE id = 1')->fetch(PDO::FETCH_ASSOC);
        $alreadyAlerted = $row !== false && $row['alerted_at'] !== null;

        if ($offline && !$alreadyAlerted) {
            $shouldAlert = true;
            $stmt = $pdo->prepare('UPDATE agent_alert_state SET alerted_at = :now WHERE id = 1');
            $stmt->execute(['now' => isoNow()]);
        } elseif (!$offline && $alreadyAlerted) {
            $pdo->exec('UPDATE agent_alert_state SET alerted_at = NULL WHERE id = 1');
        }

        $pdo->exec('COMMIT');
    } catch (Throwable $e) {
        $pdo->exec('ROLLBACK');
        throw $e;
    }

    if ($shouldAlert) {
        sendPushoverNotification('CCSW: agent offline', 'CCSW agent offline -- needs attention.');
    }
}

// The repo a job's working directory belongs to, for locking purposes: just
// the last path segment (e.g. "V:/ccswitchboard" -> "ccswitchboard"),
// tolerant of either slash direction and a trailing one.
function repoFromCwd(string $cwd): string
{
    $normalized = rtrim(str_replace('\\', '/', $cwd), '/');
    if ($normalized === '') {
        return $cwd;
    }
    $parts = explode('/', $normalized);
    return (string) end($parts);
}

// Mirrors the browser extension's extractResultText()/isErrorResultText()
// classification (browser-extension/background.js) so the board's thread
// state panel (thread_states.php) agrees with what the extension itself
// would show for the same job. $result must already be json_decode()'d once
// (the same value jobs.php/result.php hand back for a job's `result`
// column). Returns one of: 'success', 'cancelled', 'needs_input', 'errored'.
function classifyJobResult($result): string
{
    if (!is_string($result)) {
        return 'success';
    }

    // CcswAgent posts the plain string "CANCELLED" when a job is killed via
    // cancel.php -- not a failure, so it's kept out of needs_input/errored.
    if (str_starts_with($result, 'CANCELLED')) {
        return 'cancelled';
    }

    // CcswAgent posts either claude -p --output-format json's whole response
    // envelope (as JSON text) or, when claude itself never ran, one of its
    // own plain ERROR:/TIMEOUT:/LAUNCH-ERROR: markers (reapDeadJobs's
    // "ERROR: agent lost" is a server-side example of the latter).
    $envelope = json_decode($result, true);
    if (is_array($envelope) && !array_is_list($envelope)) {
        $subtype = is_string($envelope['subtype'] ?? null) ? $envelope['subtype'] : null;
        $isErrorEnvelope = ($envelope['is_error'] ?? false) === true
            || ($subtype !== null && str_starts_with($subtype, 'error'));

        if ($isErrorEnvelope) {
            // error_max_turns means claude hit --max-turns without finishing
            // -- in practice that's almost always because it stopped to ask
            // a question the caller never answered, so it's an actionable
            // "needs input" rather than a genuine failure.
            return $subtype === 'error_max_turns' ? 'needs_input' : 'errored';
        }

        return 'success';
    }

    foreach (['ERROR:', 'TIMEOUT:', 'LAUNCH-ERROR:'] as $prefix) {
        if (str_starts_with($result, $prefix)) {
            return 'errored';
        }
    }

    return 'success';
}

// Extracts the cost/token/turn/duration stats from a finished CC job's result
// envelope (see classifyJobResult's doc comment above for the exact shape
// $result takes) -- used by jobs.php to surface them in the board's "more
// info" panel and feed.php's terminal footer. Bash jobs and the plain
// CANCELLED/ERROR:/TIMEOUT:/LAUNCH-ERROR: markers carry no such envelope and
// return null.
function parseResultEnvelope($result): ?array
{
    if (!is_string($result)) {
        return null;
    }

    $envelope = json_decode($result, true);
    if (!is_array($envelope) || array_is_list($envelope) || ($envelope['type'] ?? null) !== 'result') {
        return null;
    }

    $usage = is_array($envelope['usage'] ?? null) ? $envelope['usage'] : [];

    return [
        'total_cost_usd' => $envelope['total_cost_usd'] ?? null,
        'num_turns' => $envelope['num_turns'] ?? null,
        'duration_ms' => $envelope['duration_ms'] ?? null,
        'input_tokens' => $usage['input_tokens'] ?? null,
        'output_tokens' => $usage['output_tokens'] ?? null,
        'cache_creation_input_tokens' => $usage['cache_creation_input_tokens'] ?? null,
        'cache_read_input_tokens' => $usage['cache_read_input_tokens'] ?? null,
    ];
}

// The one definition of a legal machine name, shared by machines.php (minting)
// and machine_installer.php (rendering). Deliberately narrow: the name is
// interpolated into a PowerShell script, a Content-Disposition filename and a
// download URL, and this character set is inert in all three -- which is why
// the two callers validate rather than escape their way out of trouble.
function isValidMachineName(string $name): bool
{
    return preg_match('/^[A-Za-z0-9_-]{1,32}$/', $name) === 1;
}

function readJsonBody(): array
{
    $input = json_decode(file_get_contents('php://input'), true);
    return is_array($input) ? $input : [];
}

// poll.php has side effects on a GET request (flips a job to running) and
// must never be served from the account's ea-nginx reverse-proxy cache;
// applied to every endpoint for safety. Cache-Control/Pragma/X-Accel-Expires
// are the standard no-cache signals, but the Set-Cookie is what actually
// bites here -- nginx's proxy_cache module never caches a response that
// sets a cookie (default, documented behaviour), which is what this relies
// on. Max-Age=0 so the cookie itself never lingers in a client's jar.
// Factored out of jsonResponse() so a non-JSON response (debug_log.php's
// plain-text GET) can still opt into the same cache-busting behaviour.
function noCacheHeaders(int $status): void
{
    http_response_code($status);
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('X-Accel-Expires: 0');
    header('Set-Cookie: ccsw_nocache=1; Max-Age=0; Path=/ccswitchboard/board/');
}

function jsonResponse(array $data, int $status = 200): void
{
    noCacheHeaders($status);
    header('Content-Type: application/json');
    echo json_encode($data);
}
