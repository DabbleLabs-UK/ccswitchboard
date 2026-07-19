# CCSwitchboard Relay Protocol — v1

**Protocol version:** `1` (the integer exposed by `GET version.php`, source of truth `PROTOCOL_VERSION` in `db.php`).
**Status of this document:** describes the protocol as actually served today. Where the running code and the intended future shape differ, the current reality is documented and the change is listed under [§11 Planned for v2](#11-planned-for-v2) — this spec never describes something the live relay doesn't do.

CCSwitchboard orchestrates work across independent components. This document is the contract those components speak. It exists so alternative implementations — a relay in another language, an executor on another machine or in the cloud, a non-browser client, a bespoke orchestrator — can be built against a stable published interface instead of by reading the reference PHP.

## The one architectural idea

Everything talks to the **relay**, and only to the relay. Components never talk to each other directly, and never through any "manager". An executor polls the relay for work and reports back; a client submits work and reads results; the browser extension is just one (feature-rich) client. This HTTP contract *is* the runtime interface for the whole system — there is no second channel.

A consequence worth stating up front: **the intelligence is optional.** The relay is a dumb, reliable queue that runs jobs and reports how each one ended. Deciding *what to run next* — sequencing a multi-step plan, reacting to a result — is the job of a client playing the **orchestrator** role, and is entirely outside this core. The reference system's orchestrator happens to be an LLM watching results in a browser tab; a headless deployment can use a twenty-line shell loop instead. Either way the core is unchanged. This is deliberate: it's what lets the queue outlive any particular client.

---

## Core vs optional

The contract is in two tiers:

- **Core (stable).** [§5 Executor](#5-executor-endpoints-core), [§6 Dispatch client](#6-dispatch-client-endpoints-core), [§8 Management](#8-management-endpoints-core), plus [§2 Auth](#2-authentication) / [§3 Versioning](#3-versioning). This is the queue. It is intended to be stable — changes here bump the protocol version. Any conformant relay must serve it; a headless executor + client needs nothing else.
- **Browser-integration profile (optional, may change).** [§7](#7-browser-integration-profile-optional). Wakes, plans, tab/focus tracking, delivery ACK, the action list, thread-state derivation. These make the in-chat experience work and are **not required for correctness** of the core queue. They are still evolving and are **not** frozen — treat this profile as versioned separately and subject to change. A relay may implement the core and omit the profile; a headless client may ignore the profile entirely.

---

## 1. Conventions

- **Transport:** HTTP/1.1, JSON bodies (`Content-Type: application/json`).
- **Base URL:** one base, handed to each component as `relayUrl`. It points at the directory containing the endpoint scripts (in the reference deployment, `…/ccswitchboard/board/`). All endpoint names below are relative to it.
- **Timestamps:** ISO-8601 UTC, `YYYY-MM-DDTHH:MM:SSZ`.
- **Errors:** non-2xx responses carry `{"error": "<message>"}`. Codes in use: `400` (missing/invalid field), `401` (auth, when enforced), `404` (not found), `405` (wrong method), `409` (conflict — repo locked, or cancelling a finished job).
- **Success with no data:** `{"ok": true}` (some endpoints add fields, noted inline).
- Wrong HTTP method on an endpoint → `405`.
- **Opaque identifiers:** the `thread` field (see note in §6) is an opaque, caller-chosen string. The relay never parses or derives meaning from it. (Renamed `channel` in v2 — §11.)

## 2. Authentication

- **Single shared secret**, no users and no login. Every request carries it in the **`X-CCSW-Token`** header; every endpoint checks it. This is the whole auth model: isolation between deployments is achieved by running **separate relay instances**, each with its own secret — not by multi-tenancy inside one relay.
- The token is generated server-side on first use and stored outside the web root. It is never committed and never shipped baked-in; an adopter's relay generates its own.
- **Grace mode.** A relay may run with enforcement **off**, in which case a missing or invalid token is logged but the request still succeeds. This exists only to roll auth out to existing callers before enforcing. Conformant clients MUST send the token regardless of grace mode; conformant relays SHOULD enforce (answering `401` on missing/invalid) for any deployment reachable beyond a trusted local network.
- **Security note for public deployments:** an executor runs arbitrary commands on its host. A relay reachable from the public internet with enforcement off is remote code execution by anyone who finds the URL. Enforcement is therefore a hard prerequisite before any relay or executor faces the internet — not optional.

## 3. Versioning

- `GET version.php` → `{"protocol_version": <int>}`. A component may read this to check compatibility before relying on the rest of the contract.
- One integer. **Additive, backward-compatible changes** (new optional fields, new endpoints, new outcome values) do **not** bump it. **Removing or renaming** a field/endpoint, or changing an existing shape, **does**.
- The optional browser-integration profile (§7) evolves independently of this integer and should be treated as unstable.

---

## 4. Roles

A relay serves four audiences. An implementation of a single role needs only that role's endpoints; a relay must serve them all (core mandatory, profile optional).

| Role | Consumes | Tier | Purpose |
|------|----------|------|---------|
| **Executor** | §5 | core | Runs jobs. Claims work, streams output, posts results, honours cancel, heartbeats. |
| **Dispatch client** | §6 | core | Submits jobs and reads progress/results/outcomes. The minimal client. |
| **Orchestrator** | §6 (result-ready + outcome) | core | *A specialisation of a dispatch client*, not extra endpoints. Watches for jobs finishing and decides the next job. Sequencing lives here, never in the relay. |
| **Browser integration** | §7 | profile | Optional in-chat UX: wakes, plans, tabs, delivery, actions, thread states. |
| **Management** | §8 | core | Operational control (force-release locks). |

A **repo** is the unit of mutual exclusion. It is derived from a job's `cwd` (last path segment), or overridden per §6.1. At most one non-readonly job holds a given repo's lock at a time.

---

## 5. Executor endpoints (core)

An executor runs jobs and reports back, identifying itself with a free-form `machine` string used for liveness and reaper logic. **Job dispatch is by type:** the relay stores the job payload opaquely and never interprets it; the executor inspects `payload.type` to decide how to run the job (`"bash"` runs a shell command; absence of `type` runs the default job kind — a Claude Code prompt in the reference executor). New job types are an executor concern and require no change to this contract.

### 5.1 Claim a job — `GET poll.php?machine=<id>`

Atomically claims the oldest `pending` job and marks it `running` (recording `machine` + start time). `{"job": null}` when empty, else:

```json
{ "id": 123, "payload": { … }, "thread": "…", "continue": false }
```

`continue: true` → resume this thread+repo's prior session (§5.5).

> The relay hands the oldest job to whichever executor polls first; it does **not** currently route by machine capability. A multi-executor pool where executors can't all serve every repo needs affinity routing, which this version does not provide (§11).

### 5.2 Stream output — `POST append.php`

```json
{ "job_id": 123, "text": "<chunk>" }
```

Appends a chunk; the relay assigns a monotonic `seq` per job and returns `{"ok": true, "seq": <n>}`. Stream line-by-line as work proceeds.

### 5.3 Post the result — `POST result.php`

```json
{
  "id": 123,
  "result": <any JSON>,
  "machine": "…",          // optional; preserves poll's machine if omitted
  "session_id": "…",       // optional; resumable session handle
  "session": "default"     // optional session label
}
```

Marks the job `done`, stores `result`, **derives and stores the job's `outcome`** (see §6.2), releases the job's repo lock, wakes waiters. If `session_id` is given it's recorded keyed by (thread, repo-from-payload-cwd, label) for later `continue`. `404` on unknown id.

`result` is opaque to the relay. By convention it's either a readable string (including `ERROR: …` / `TIMEOUT: …` markers when the underlying tool never ran) or the executor's structured result envelope (cost/token/turn stats). Clients that understand the envelope parse it; others treat `result` as a string and rely on `outcome`.

### 5.4 Honour cancellation — `GET cancel.php?job_id=<id>`

Polled by the executor while a job runs → `{"cancel_requested": <bool>}`. On `true`, kill the job's process tree and post a `CANCELLED` result via §5.3. (Client-facing POST side: §6.6.)

### 5.5 Resume lookup — `GET session.php?thread=<t>&repo=<r>&session=<label>`

→ `{"session_id": <string|null>}`, for resuming a `continue` job. `label` defaults to `"default"`. `thread` and `repo` required.

### 5.6 Heartbeat — `POST heartbeat.php`

```json
{ "machine": "…" }
```

Liveness ping, keyed by machine. A reconnecting executor signals the relay to re-queue jobs that went stale while it was dark. A machine is considered offline once its heartbeat exceeds the agreed cutoff, which drives dead-job reaping and offline alerts. (GET side: §6.8.)

---

## 6. Dispatch-client endpoints (core)

The minimal surface to submit a job and follow it. A headless client and an orchestrator need only these.

### 6.1 Submit a job — `POST job.php`

```json
{
  "payload": { … },        // required
  "thread": "…",           // optional identity string
  "continue": false,       // optional — resume this thread+repo session
  "readonly": false        // optional — bash only; skip the repo lock
}
```

**Payload** (handed to the executor verbatim; the relay reads only the lock-relevant fields and passes the rest through):

- `cwd` (string) — working dir / readable scope; the locked repo derives from it unless overridden.
- `name`, `summary` — short label and one-line blurb for UIs.
- `type: "bash"` — plain-command job (executor runs `command`, no model). Default-type jobs omit `type` and carry `prompt` + `model`.
- pass-through fields the executor/clients consume: `final`, `plan`, `silence_timeout`, `session`, `model`, `prompt`, `command`.

**Lock control** (independent of `cwd`, which always still sets executor scope):

- `payload.locks: ["a","b"]` — lock all, all-or-nothing, one transaction (cross-repo job).
- `payload.lock_repo: "r"` — lock this single repo instead of the one derived from `cwd`.
- neither — lock on the repo derived from `cwd`.

**Responses:**

- `{"id": <int>}` — created.
- `409 {"locked": true, "held_by": "<thread>", "held": [{"repo","thread"}…]}` — one or more requested repos already locked; **no job created, no locks taken**. The requesting thread is enqueued as a waiter on repos held by *other* threads and receives a repo-free wake (§7.1) when they free. The client re-decides and re-submits then; the job is **not** queued on its behalf.
- `readonly: true` bash jobs skip locking and run in parallel with a lock-holder.

### 6.2 Read a result — `GET result.php?id=<id>`

```json
{
  "id": 123, "status": "done", "result": <any|null>, "outcome": "success",
  "thread": "…", "name": "…", "summary": "…",
  "final": false,
  "delivered": false
}
```

**`outcome`** is the authoritative terminal-state stamp, computed by the relay when the job finished — the signal an orchestrator should key off rather than parsing `result` strings. One of:

| `outcome` | meaning |
|-----------|---------|
| `success` | finished normally |
| `errored` | failed (tool error, launch failure, timeout, agent lost) |
| `cancelled` | cancelled before/while running |
| `needs_input` | stopped awaiting caller input (e.g. hit a turn limit mid-question) — actionable, not a failure |

`outcome` is null only for jobs that haven't reached a terminal state. New outcome values may be added additively. `delivered` is a durable server-side ACK flag (§7.5). `404` on unknown id.

### 6.3 Read streamed output — `GET output.php?job_id=<id>&after=<seq>`

Chunks with `seq > after` (0 for all), oldest first:

```json
{ "chunks": [ { "seq": 1, "text": "…", "at": "<iso>" }, … ] }
```

Poll with the last seen `seq` as `after` to tail a running job.

### 6.4 Lightweight status — `GET status.php?id=<id>`

Just the fields a status line/timer needs (never the result/output blob): `id, status, thread, name, summary, updated_at, started_at, created_at, is_command`. `404` on unknown. Use for cheap per-job polling instead of §6.5.

### 6.5 List jobs — `GET jobs.php?status=<s>&limit=<n>&max_age=<secs>`

Board listing. `status` ∈ `pending|running|stale|done|all` (default `done`). `limit` 1–500 (default 50). `max_age` filters by `updated_at`; `0` = no filter. Each job carries: `id, status, result, result_stats, outcome, thread, repo, name, summary, model, prompt, silence_timeout, continue, session, is_command, final, delivery_pending, updated_at`, plus a top-level `agentOffline` bool.

> This response is a denormalised **convenience view** for board rendering, not a frozen shape — several fields are derived or defaulted. Treat the stable per-job facts as those also available via §6.2/§6.4; don't depend on the exact `jobs.php` object across versions.

### 6.6 Request cancel — `POST cancel.php`

```json
{ "job_id": 123 }
```

`pending` → finalised `CANCELLED` immediately (lock released, waiters woken, outcome `cancelled`). `running` → flagged; the executor's poll (§5.4) does the kill and posts the result. `409` if already `done`, `404` if unknown.

### 6.7 Resume a stale job — `POST resume.php`

```json
{ "job_id": 123 }
```

Flips a `stale` job (waited too long for a worker) back to `pending`. `404` if not found or not stale.

### 6.8 Agent liveness — `GET heartbeat.php`

→ `{"online": <bool>, "latest": "<iso|null>"}`. Whether any executor is currently alive, without listing jobs.

---

## 7. Browser-integration profile (optional)

Everything in §7 supports the in-chat experience and is **not required** for a correct headless queue. It is **not frozen** — expect change. All of it keys off the opaque `thread` identity.

### 7.1 Repo-free wake — `GET wake.php` / `POST wake.php`

Ack-based single-item claim queue; the relay enqueues a wake for a thread when a repo it waited on frees.

- `GET` → claims (not deletes) the oldest unclaimed/claim-expired wake: `{"thread": <string|null>, "repo": <string>}`. An unacked claim is re-offered after a debounce window (survives tab churn / worker restarts).
- `POST {"thread","repo","ack":true}` → deletes the wake, once the client confirms the nudge landed. Scoped to thread **and** repo. `400` if any field missing.

### 7.2 Plan-quiet nudge — `GET plan_wake.php`

One-shot pop-and-delete queue: `{"thread": <string|null>}`. Enqueued when a thread with an open plan goes quiet.

### 7.3 Persist a plan — `POST plan.php`

```json
{ "thread": "…", "plan": ["Job One", "Job Two"] }
```

Records a thread's current plan so the relay can tell whether a quiet thread still has open work. Empty/omitted `plan` clears it. `400` if `thread` missing.

### 7.4 Tab registry — `POST register_tab.php` / `GET register_tab.php?thread=<t>`

- `POST {"thread","tabId"}` → upserts the thread→tab mapping.
- `GET ?thread=<t>` → `{"thread","tabId","updated_at"}`, or `404`.

### 7.5 Delivery / focus / actions

- **`POST delivery.php`** — `{"job_id","pending":<bool>}` toggles the "held for delivery" indicator; `{"job_id","delivered":true}` sets the durable ACK (`delivered_at`) that §6.2's `delivered` reports, so a result-watcher stops re-offering a job once its nudge has landed. `404` if unknown.
- **`GET focus_request.php` / `POST {"thread"}`** — pop-and-delete queue of "raise this thread's tab" requests. GET → `{"thread": <string|null>}`.
- **`GET/POST actions.php`** — global (not per-thread) manual-action list. `GET` → `{"actions":[{"id","text","tier","created_at"}…],"counts":{…}}`. `POST {"add":[{"text","tier"}…]}` and/or `{"clear":[id,…]}`, both returning that shape. `tier` ∈ `blocking|recommended|nice_to_have`; malformed items skipped, not rejected.
- **`GET thread_states.php?max_age=<secs>`** — per-thread state (`active|needs_input|errored|dormant|idle`) derived from job rows, sorted severity then recency: `{"threads":[{"thread","state","last_activity","latest_job_id","latest_summary","job_count"}…]}`. Pure presentation heuristics — the least stable endpoint in the profile.
- **`GET/POST debuglog.php`** — central cross-tab debug log. A content script only sees its own tab, so events funnel content-script → background worker → here. `GET ?since=<id>&limit=<n>&type=<t>` → `{"events":[{"id","ts","build","thread","type","detail"}…]}`, oldest-first, `limit` clamped to 1000 (default 150). `POST {"events":[{"ts","build","thread","type","detail"}…]}` → `{"ok":true,"inserted":<n>}`; malformed events skipped, not rejected. `build` is the extension's `CCSW_BUILD` stamp — a tab reporting an old build is a stale tab that was never reloaded. Rotating: trimmed to the newest 2000 rows per POST, so it's a diagnostic tail, not an audit trail. Not to be confused with `debug_log.php` (underscore), the older flat-file `{tag,data}` channel.

---

## 8. Management endpoints (core)

Operational escape hatches for stuck state.

- **`POST clear_lock.php`** — `{"repo"}` force-releases one repo's lock (for a job whose executor died and will never post a result). `404` if no lock held.
- **`POST clear_locks.php`** — force-releases every lock. Returns `{"ok":true,"cleared":<count>}`.

---

## 9. Semantic verbs & transport

The core delivery interactions are defined **semantically**, so an implementation may realise them by polling (as the reference relay does) **or** by push (SSE / WebSocket / webhook) without breaking conformance. **Cadence is not part of the contract** — poll intervals are a client's own choice, never a shared constant.

| Verb | Meaning | Reference realisation |
|------|---------|-----------------------|
| `get-next-job` | executor obtains the next pending job | `GET poll.php` (atomic claim) |
| `report-result` | executor reports terminal result + outcome | `POST result.php` |
| `result-ready` | a client learns a job reached a terminal state | polled `GET result.php` / `jobs.php` / `status.php` |
| `cancel-requested` | a running job learns it should stop | polled `GET cancel.php` |
| `wake-available` | a client learns a queued signal awaits it | polled, ack-based `GET/POST wake.php` (already redelivery-tolerant — the shape a push+ack transport wants) |

**Housekeeping is the relay's own responsibility, not a side effect of traffic.** Reaping dead jobs, releasing orphaned locks, promoting stale jobs, and firing offline/plan alerts must run on the relay's own schedule (the reference deployment drives them from an external cron tick), so they happen even when no client is polling and no executor is alive. An implementation that folds housekeeping into request handling must not *depend* on requests arriving.

---

## 10. Guarantees & semantics (implementer notes)

- **Liveness is per-machine, not per-job.** A running job is considered lost when its executor's *machine* heartbeat goes stale (not via any per-job lease); the lock's timestamp is recorded but not read as an expiry. A job whose machine keeps heartbeating after the underlying worker dies is caught by the executor's own silence timeout, not the relay.
- **At-most-once, no redelivery, no dead-letter.** A lost job is marked terminal (`outcome: errored`) and **not** retried. There is no visibility-timeout requeue and no dead-letter queue. Clients/orchestrators that want retry implement it themselves by resubmitting.
- **No idempotency key.** Two submissions are two jobs. A client that must not double-submit dedupes on its side.
- **Mutual exclusion.** At most one non-readonly job per repo; multi-repo locks are all-or-nothing; readonly bash jobs bypass locking entirely.

---

## 11. Planned for v2

Documented here so implementers can anticipate them; **not yet in the live protocol.**

- **`thread` → `channel` rename.** The opaque identity field is named `thread` today (a leak of its claude.ai origin). It will be renamed `channel` across every endpoint and the schema. This is a breaking change and will bump the protocol version.
- **Logical-repo working-dir contract.** Today `payload.cwd` is a filesystem path that must be meaningful on the executor's machine — which breaks for a cloud executor with no shared filesystem. A future revision replaces "a shared absolute path" with "a logical repo name the executor resolves to its own local checkout (optionally provisioning it)". The relay already treats `cwd` opaquely, so only the executor and payload schema change.
- **Machine-affinity routing** for multi-executor pools (see §5.1) — so a job is only handed to a machine that can serve its repo/type.
- **Distinct terminal statuses** may be surfaced alongside `status: "done"` (the `outcome` field already carries the taxonomy; a future version may promote it into the status set).

---

## 12. Implementing a role — checklist

**A relay** serves §5, §6, §8 (core) and enforces (or grace-modes) the §2 token on every endpoint, exposes §3's version, provides the repo-lock guarantee (§10), and runs housekeeping on its own schedule (§9). The §7 profile is optional.

**An executor** must: poll (§5.1), stream (§5.2), post results (§5.3), poll cancel and kill on request (§5.4), look up sessions for `continue` jobs (§5.5), heartbeat (§5.6). Dispatch on `payload.type`. Send the token on every call; identify with a stable `machine` string.

**A dispatch client** needs only §6. Handle the `409` locked response by re-deciding (the job did not queue). Treat `result`/`result_stats` as opaque unless it understands the envelope; prefer `outcome` for terminal state.

**An orchestrator** is a dispatch client that watches `result-ready` + `outcome` and decides the next job. All sequencing lives here; the relay offers no dependency graph by design.

**A browser (or other rich) client** adds §7 on top of §6 as needed — none of it is required for correctness, only for the in-chat UX, and it is subject to change.